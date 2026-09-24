# シナリオ × プロバイダ Tier のルーティングと、ペースによる自動調整

Status: Approved（2026-09-24）

親ドキュメント:

- [quota-and-tier-routing.md](./quota-and-tier-routing.md) — v2.89.0 で入れた「要求 tier → provider · tier」のティアマップ。本書はそのキーを置き換える
- [subscription-utilization-tuning.md](./subscription-utilization-tuning.md) — Level 3 の「利用率でしきい値を動かす」構想。本書で実装する

## 背景

v2.89.0 で、ルーティングは「要求されたモデルの tier（fable / opus / sonnet / haiku / other）→ provider · tier のリスト」になった。これは運用者の要望とずれていた。

- **最初の要望**：「Routing をプロバイダと Tier で指定したい」。
  - 意図は、**シナリオごとの振り分けはそのままにして**、中身をモデル名から provider · tier に変えることだった。
  - キーまで要求 tier に替える必要はなかった。
- **v2.89.0 の起動ログ**で、次の問題が分かった。
  - `think` / `longContext` / subagent のレーン（15 件）が変換されず、消えた。
  - Opus 指定の要求が Sonnet に回るようになった。
- **運用者が付けたい機能**：Fable を余らせないこと、そしてこのペースなら上限に達しそうなときに Tier を下げること。
  - 旧実装にはどちらもなかった。scheduler は利用率から重みを計算していたが、振り分けは「重みが 0 か」しか見ていなかった。
  - しきい値の自動調整（Level 3）も、設計のスケッチだけで実装されていなかった。

## 設計

### データモデル

| 何を | どう持つか |
|---|---|
| シナリオ | `default` / `think` / `longContext` の 3 つ。`image` と `webSearch` は廃止する。Web 検索は、実行できないルートを飛ばすゲートとして残る |
| レーン | `agent` / `subagent`（サブエージェントタグの有無） |
| ルート | `(profile, scenario, lane, priority) → (provider, tier, enabled)`。`TierRoute` テーブルのキーを `requestedTier` から `scenario` と `lane` に替える |
| モデル | ルートは持たない。`ProviderTierAlias` が「このプロバイダの sonnet はどのモデルか」を決める（v2.89.0 のまま） |

### リクエストの振り分け

1. サブエージェントタグを除去し、レーンを決める。タグがあれば `subagent`、なければ `agent`。除去は passthrough でも行う。
2. passthrough の面や予約プロファイルなら、ここで終わる。
3. シナリオを決める。
   - 入力トークンがしきい値を超えれば `longContext`。
   - そうでなく thinking（Anthropic の `thinking`、OpenAI の `reasoning_effort` / `reasoning`、Gemini の `thinkingConfig`）があれば `think`。
   - どちらでもなければ `default`。
4. `(scenario, lane)` のリストに、使えるルートが 1 本もなければ `(default, lane)` に落とす。`default` も空なら passthrough する（呼び出し側のモデルのまま送る）。
5. リストのルートを、v2.89.0 と同じ順のゲートにかける。
   - 無効
   - エイリアス未設定
   - Web 検索を実行できない
   - コンテキストに収まらない
   - 使い切り
   - エラー率
6. 通ったルートを、**ペース**で並べ替える（次節）。
7. 結果の扱いは v2.89.0 と同じ。
   - 振り分けた場合は、先頭を使い、残りをフォールバックにする。
   - 全ルートが使い切りなら、429 か passthrough のどちらか（`exhaustedBehavior` による）。
   - 設定上どれも受けられない場合は 400。

### ペース

- **判定の元**：各ターゲット（provider, model）について、そのアカウントの各窓（5h / 週 / Fable の週枠）ごとに「このペースならリセット時点で何 % 使うか」を見込む。
- **見込みの式**：`使用率 ÷ 経過割合`。
- **判定しないとき**：経過が窓の 10 % 未満のときは判定しない（null）。
- **ターゲットの見込み**：アカウントごとに最も厳しい窓を取る。それをプラン容量（Pro=1 / Max=5 / Max20=20）で重み付けして平均する。
- **並べ替え**：
  - **余り**（見込み 60 % 未満）の組み合わせを、リストの**先頭に繰り上げる**。
  - **超過**（見込み 100 % 超）の組み合わせは、リストの**末尾に下げる**。これで、運用者がその下に置いた下位 Tier が使われる。
  - それ以外（見込み不明を含む）は、リストの順のまま。
  - どちらのグループの中でも、元の順を保つ。
  - 全部が超過なら、リストの先頭を使う。見込みだけで 429 にはしない。

scheduler の snapshot は、ターゲットごとに `projectedPct` を載せる。

### Long context のしきい値

- **基準値（auto）**：`(default, agent)` の先頭ルートが解決するモデルのコンテキスト長 × 70 %。解決できなければ 128k。
- **調整**：scheduler の tick の中で、プロファイルごとに **24 時間に 1 回まで**行う。対象は `(longContext, agent)` の先頭ルートの見込み。
  - 見込み 60 % 未満 → しきい値を 20 % 下げる。Long context に入る要求が増える。
  - 見込み 100 % 超 → 20 % 上げる。
  - 見込みが null なら動かさない。
- **範囲**：`[30,000, 基準値]`。基準値より上には上げない。それ以上の入力は、Default のモデルに入らなくなるため。
- **巻き戻し**：下げてから 24 時間以内に対象が使い切りになったら、前の値に戻す。
- **記録**：変更は `info` ログに残す。前の値は `constraints.previousLongContextThreshold` に保存する。
- **無効化**：`constraints.autoTuneLongContext`（既定 true）で止められる。画面には出さない。
- **画面**：Long context の行の条件に「input over 700k tokens (auto)」のように、今の値を出す。

### 画面

[mocks/routing.html](../../mocks/routing.html)（#539）が仕様である。

- 表は「シナリオ × Agent / Subagent」。各セルに provider と tier バッジの組み合わせを上から並べる。
- 各行には並べ替え、ON / OFF、削除、クリックでの変更がある。
- 追加はダイアログで行う。①プロバイダ → ②Tier。そのプロバイダにモデルのない Tier は選べない。
- 要約、使用量、状態、制約の欄は出さない。モデル名も出さない。

Activity の列名は「Route」から「Scenario」に戻す。`RequestLog.scenario` にシナリオ（または `passthrough`）を書く。

### 移行

- **#535 を取り消す（#540）**：v2.89.0 の本番には旧チェーン（`RouterPreferenceEntry`）が全レーン分残っている。#535 はそれを消すので、取り消しが必要。
- **マイグレーション**：
  - 要求 tier で持っていた `TierRoute` の行を消す。要求 tier はシナリオにならないので、写せない。
  - 全プロファイルの `chainBackfilledAt` を NULL に戻す。
- **次の `db seed`**：旧チェーンを `(default | think | longContext) × (agent | subagent)` に変換し直す。
  - エントリは、そのモデルの tier のエイリアスに解決する。既存のエイリアスは上書きしない。
  - 同じ provider · tier の重複は 1 本にまとめる。
  - ON / OFF はエントリのまま。tier ゲートの ON / OFF 変換はしない。
  - `webSearch` / `image` のレーンは件数だけをメモに残す。
- **戻らないもの**：v2.89.0 以降に Routing 画面で編集した内容は戻らない（キーが違うため）。

## PR

| PR | 中身 |
|---|---|
| #540 | #535 の取り消し |
| #539 | モック |
| 本体（1 本） | スキーマとマイグレーション、変換の作り直し、振り分け（シナリオ判定・ペース・しきい値調整）、API、画面、Activity、seed-demo、テスト、docs |

縮退マイグレーション（旧チェーンの削除）は、本体が本番で一度起動した後に出し直す。

## Non-goals

- シナリオの追加（`image` / `webSearch` の復活）
- しきい値の手動上書きの UI（`constraints.longContextThreshold` は API から書ける）
- 利用率ダッシュボード（Level 2）
