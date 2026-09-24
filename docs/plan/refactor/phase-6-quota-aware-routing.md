# Phase 6: Quota-Aware Routing

> **置き換え済み（2026-09）:** 本書のルーティング設計はティアマップ（要求ティア → プロバイダのティアエイリアス）に置き換えられた。現行の設計は [quota-and-tier-routing.md](../quota-and-tier-routing.md) を参照。

Status: Planning

Phase 5（同一プランの複数アカウント運用）の上に乗る。アカウントを「持てる」ようになった次の段として、レートリミットのリセットタイミングと窓別使用量を見て、リクエストを自動配分する。

## Objective

レートリミットのリセットタイミングと窓別使用率を見て、

- 7d（週次）窓には**絶対に引っかからない**
- 5h 窓は**バーストして使い切ってよい**
- **余剰の大きい 7d Sonnet 枠を主力ワークホースとして積極的に使い切る**
- 遊休の Codex を先に消費し、希少な Opus 7d 枠を温存しつつ取り残しなく配分する

ように動的ルーティングする。

## Problem

### 具体状況

- アカウント構成: Claude x2、Codex x1。
- Codex がかなり余っている一方、Opus の 7d 枠がギリギリ。
- リクエストは分割可能だが、コンテキストが長くなると Sonnet で対応できず Opus か GPT-5.4 に限られる。
- 「5h は引っかかってもよい」「7d は引っかかりたくない」が硬さの差。

### 根本原因（実装の確認結果）

データ層は窓を分けて取得済みなのに、消費側がほぼ 5h しか見ていない。守りたい 7d を無視して、引っかかってよい 5h で判断している。

取得済みデータ（`src/services/usage-service.ts` / `src/schemas/usage.dto.ts`）:

- Claude: `fiveHour` / `sevenDay` / `sevenDaySonnet` / `sevenDayOpus`、各 `{ utilization(0-100), resetsAt }`
- Codex: `primary` / `secondary`、各 `{ usedPercent, resetAt, windowSeconds }`

消費側が捨てている箇所:

- `getCachedUsagePct(subAccountId, kind)` … Claude は `fiveHour.utilization` のみ、Codex は `primary.usedPercent` のみ。
- `claudeWindow` / `codexWindow`（`getKindHeadroom` → `headroomFrom` の元データ）… `fiveHour` / `primary` のみ。
- `PROACTIVE_THRESHOLD_PCT = 95` の固定しきい値で、しかも「全アカウントが超過」したときだけ `overLimit`。
- `applyProactiveFailover` / `candidateUsable`（`src/llms/scenario-router.ts`）はこの 5h ベースの `overLimit` を使う。
- `resolveAccountForSession`（`src/services/session-account-router.ts`）は 5h ベースの `getCachedUsagePct` 最小でアカウントを選ぶ。

結論: `sevenDayOpus` は取得・スナップショット化（`usage-history-service.ts` の `claude.seven_day_opus`）まではされているが、**ルーティング判断には一切流れていない**。

## Design Decision: 汎用ソルバは使わない

検討の記録。当初は配分計算に MILP ソルバを使う案を検討したが、実際の形状を確認した結果、採用しない。

理由:

- レーンが 3 本（Claude x2 + Codex x1）、リクエスト分割可能、硬制約は実質 7d の 1 本。この規模・構造では貪欲な優先順位カスケードがそのまま最適になり、ソルバが貪欲に勝つ余地がない。
- 窓別データと `resetsAt` から線形ドレイン目標を引くのは `min()` / water-filling 相当で数行。最適化エンジンを要しない。
- npm 配布の CLI にネイティブ MILP 依存（CBC / OR-Tools）を持ち込むのは配布・パッケージングのコストが高く、判断の不透明さも増える。
- ブロック回避は本質的に「不確実な将来需要に対するオンライン制御」で、セッション頭の一発最適化は途中で陳腐化する。軽い再評価ポリシーのほうが頑健。

将来、リクエストが分割不能でサイズがいびつ・プロバイダ間に組合せ制約・請求用に最適性証明が必要、のいずれかが複数重なったら、その部分にだけ WASM ソルバ（`glpk.js` / `highs-js`、ネイティブ依存を避けられる）を局所投入する余地を残す。それまでは入れない。

## Policy Spec

### 窓の硬軟マップ

| 窓 | 硬さ | 方針 |
|----|------|------|
| 5h | soft | 超過可。フェイルオーバのトリガにしない |
| 7d（全体） | hard | ドレイン目標で守る。Sonnet を寄せてもここは越えない |
| 7d Opus | hard・希少 | 最重要。温存対象。長コンテキストでだけ使う |
| 7d Sonnet | 潤沢・**最優先** | 主力ワークホース。Sonnet で足りる限りここへ寄せて積極消費 |
| Codex primary/secondary | 遊休 | 長コンテキストで先に使い切る |

注: Sonnet を積極消費しても overall `sevenDay`（全体週次）は消費する。7d guard は `sevenDayOpus` だけでなく overall `sevenDay` も対象にし、Sonnet の寄せはこの全体ドレイン目標の範囲内で行う。

### 硬不変条件（7d guard）

各 Claude アカウントの 7d / 7d Opus の投影使用率を上限未満に保つ。線形ドレイン目標で判定する。

- 窓長 `W`（5h=5時間、7d=7日、Codex=`windowSeconds`）、`resetsAt`、`now` から経過率 `f = 1 - (resetsAt - now) / W`。
- 目標線: `utilization <= f * 100 + margin`。
- `utilization` が目標線を**上回る** = 7d を前借りしている → そのアカウントの Opus を避け、Codex か別アカウントへ。
- **下回る** = 余裕あり → Opus 使用可。

5h はこの guard の対象外。バーストして 100% に張り付いてよい。

### ルーティング梯子（コンテキスト長で決まる）

リクエストをコンテキスト長で分類し、上の段から順に当てる。能力ゲート（Sonnet が扱える長さか）が段を決め、各段の中で窓ヘッドルームが配分を決める。

1. **Sonnet で足りる（既定の主力）**: Sonnet。7d Sonnet が余りまくっているので、ここに最大限寄せる。7d Opus を一切食わない。2 アカウントの 7d Sonnet ヘッドルームで分散。5h が熱くても気にしない（soft）。唯一の上限は overall `sevenDay` のドレイン目標。
2. **Sonnet では足りない（long context: Opus or GPT-5.4）**:
   1. まず Codex（遊休を先に drain）。Codex 窓が目標超過していなければここ。
   2. Codex が逼迫したら、7d Opus ヘッドルーム（目標比）が最大の Claude アカウントの Opus。7d guard を割らない範囲のみ。5h は熱くなってよい。
   3. 全 Claude アカウントが 7d Opus 目標に達したら throttle / queue。7d は越えない側を選ぶ。

要するに「Sonnet で行けるなら Sonnet、長さで弾かれたときだけ Codex → Opus」。Opus はコンテキスト長で強制されたときの最後の手段に押し下げる。

### アカウント選択

`resolveAccountForSession` を窓別ヘッドルームで選ぶ:

- 争点クラス（long ctx）: 7d Opus ヘッドルーム最大のアカウント。
- 短コンテキスト: 7d Sonnet ヘッドルーム最大のアカウント。

sticky マッピングは維持する（プロンプトキャッシュ継続のため）。

### 使い切り（drain）の扱い

目標線を**下回っていて、かつ reset が近い**アカウント・窓を tie-break で優先消費する。これで「取り残し最小化」と「なるべく使い切る」を両立する。

## ルーティング入力シグナルと要求モデルの扱い

### 要求モデルは満たしていない（現状の確認）

`selectModel`（`scenario-router.ts`）は `body.model` を**シナリオで上書きする**。Claude Code の要求モデルは「haiku → `background` のトリガ」「`router.default` 未設定時の最終フォールバック」としてしか使われず、要求ティア（opus/sonnet）は尊重されない。明示指定（`provider,model` のカンマ形式、`<CCR-SUBAGENT-MODEL>` タグ）だけは素通しする。

さらに重要なのは**能力保証がない**こと。`Model.contextWindow` は DB にあり `compose.ts:90-91` が `modelContextWindows` まで組んでいるのに、router の `ConfigProvider` ビューはモデル**名**しか持たない（`compose.ts:99`）。よって「振り先モデルが要求コンテキストに収まるか」は検査されず、固定 `longContextThreshold` が代用しているだけ。窓を超える振り先に飛ばすと upstream の 400 で初めて気づく（事後）。Sonnet に寄せる方針では、ここを proactive に塞ぐ必要がある。

### 入力シグナルの優先順位

「このリクエストはどれだけ重いか」を次の順で判定する（上が優先、無ければ下へフォールバック）:

1. `output_config.effort`（`low/medium/high/xhigh/max`）— 段階的で最も直接的。`route.ts` で既にパース済み。
2. `thinking.budget_tokens` — 拡張思考の段階（現状は有無のみ使用）。
3. messages トークン数 — サイズ（現状 `longContext` で使用）。
4. 要求モデルのティア（opus/sonnet/haiku）— Claude Code の意図。

グレーディング例: effort `low/medium` または要求 sonnet/haiku → Sonnet レーン。effort `high/xhigh/max` または要求 opus → Opus/long レーン。effort は新しめの Claude Code が送る形なので、無い世代は thinking/サイズへフォールバックする。

### 能力ゲート

振り先モデルが要求を満たせることを保証する。最低限 `Model.contextWindow >= 推定トークン数` を検査し、満たさない振り先は候補から外す（Sonnet で溢れるなら long レーンへ）。`compose.ts` の `modelContextWindows` を router ビューに載せれば原資は足りる。

## Implementation Slices

1PR = 1テーマ。上から順に、各スライスは前のスライスの上に乗る。

- **S0 応急（config のみ・即効）**: 2 つ同時に効く。(1) `Router.default`（と Sonnet で足りるシナリオ）を Sonnet モデルに向け、主力を余剰の 7d Sonnet へ寄せる。(2) `Router.fallbacks.longContext` を `[codex, claude-opus...]` 順にして Opus を後置。コード変更なしで 7d Opus 逼迫を即座に緩める。
- **S0.5 入力シグナル・グレーディング（usage 非依存・早期着手可）**: `selectModel` に `output_config.effort` / 要求モデルティアの判定を追加し、軽いリクエストを Sonnet レーン、重いリクエストを Opus/long レーンへ振る。effort も `body.model` も既に router が受け取るボディ内にあるので migration 不要の局所変更。usage-window 機構（S1-S2）に依存せず先行で出せ、低/中 effort トラフィックを Sonnet へ流すだけで Opus 7d が即座に楽になる。能力ゲート（contextWindow 検査）は S3 で追加。
- **S1 データ層**: `usage-service` に窓指定ヘッドルームを追加。`getKindHeadroom` を窓選択可能にするか、新たに `getAccountHeadroom(subAccountId, { window })` を足す。`sevenDay` / `sevenDayOpus` / `sevenDaySonnet` / Codex `secondary` を読む。線形ドレイン目標ヘルパを追加。
- **S2 失効判定**: `candidateUsable` / `applyProactiveFailover` を 5h でなく 7d guard で判定。`markProviderExhausted` の `until` を 7d の `resetsAt` 基準にする。
- **S3 ティア認識ルーティング**: long context クラスで「Codex 優先 → 7d Opus ヘッドルーム最大アカウントの Opus」のカスケード。短コンテキストは Sonnet 固定。`selectModel` / `applyProactiveFailover` を拡張。あわせて能力ゲート（`Model.contextWindow` を router ビューに載せ、振り先が要求コンテキストに収まることを保証。溢れるなら long レーンへ）を追加。
- **S4 アカウント選択**: `resolveAccountForSession` を窓別ヘッドルームで選ぶ。
- **S5 設定面**: ポリシーのノブ（ドレイン目標 on/off、margin%、窓別 soft/hard、tier preference）を `RouterSlot.params` か `Router` スキーマに追加。UI 露出は後続。
- **S6 可観測性・テスト**: 各窓のヘッドルームとルーティング判断をログ。ユニットテストを追加。

## Open Decisions（要確認）

- どのシナリオを Sonnet-first にするか。`default` は確定。`think` は「リクエストに `thinking` ブロックが乗っているとき」全般（Plan Mode に限らず、ultrathink 等の明示的拡張思考も該当）に発火するので量が多く、拡張思考の質は Opus と Sonnet で差が出やすい。`webSearch` ともども出力品質と Opus 温存のトレードオフ（品質を取るなら Opus 据え置き）。
- overall `sevenDay`（全体週次）も hard guard 対象にするか。Sonnet を積極消費しても全体 7d を割らないため、基本は対象にする方針。
- ポリシー設定の置き場所: `RouterSlot.params`（scenario 毎）か、`Router` 直下の新フィールドか。
- 5h を完全に無視するか、「直近の `resetsAt` まで」程度は緩く見るか。
- short / long の境界（`longContextThreshold`）。既定 60k は Sonnet の実上限（200k〜）よりずっと小さく、Sonnet で処理可能な 60k〜上限帯まで `longContext`（Opus/Codex 想定）へ飛ばしてしまう。7d Sonnet を使い倒す方針なら **Sonnet 実上限近くまで引き上げ**、その帯域を `default`(=Sonnet) に残すのが本筋。`longContext` は「本当に Sonnet で無理な長さ」だけに絞る。
- `longContext` と `think` は直交トリガ（サイズ vs 拡張思考の有無）で、`selectModel` では `longContext` が先に評価される。よって「長い & 拡張思考」は `longContext` に落ち、`think` スロットには来ない。`think` に来るのは閾値以下サイズで thinking が乗ったリクエストのみ。
- throttle 時の既定挙動: 待つ / キューする（7d 超過 NG なので既定はこちら）。
- Codex `secondary` 窓の扱い: 週次相当なら 7d 同様 hard とするか。

## Test Plan

- ドレイン目標境界: 目標線の上下で divert が切り替わる。
- Sonnet で足りるリクエストは既定で Sonnet に乗り、閾値を超えたときだけ Codex → Opus へ escalate する。
- 7d Sonnet を寄せても overall `sevenDay` のドレイン目標を割らない。
- 2 Claude アカウントで 7d Sonnet / 7d Opus がそれぞれ分散する。
- Codex 優先 drain → Codex 逼迫で Opus へ移る。
- 短コンテキストが Opus を食わない。
- 既存の 5h-only 挙動を壊さない回帰確認。

## Dependencies

- Phase 5（Multi-Account Same Plan）の `SubAccount` / `activeSubscriptionAccount` / `session-account-router` に依存する。
