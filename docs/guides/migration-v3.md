# v3 移行ガイド（Claude Code Router → Rialto）

「Claude Code Router」から **Rialto** へのリネームで、ホームディレクトリ・環境変数・
データベース名・Docker イメージがすべて変わった。旧名は**もう読まれない**（唯一の例外は
`<CCR-SUBAGENT-MODEL>` タグ）。

自動で移行されるのはホームディレクトリだけである。残りは手作業が要る。

## 一覧

| 旧 | 新 | 移行 |
|---|---|---|
| `~/.claude-code-router` | `~/.rialto` | **自動**（初回起動時にコピー→検証→旧削除） |
| `CCR_ACCOUNT_ENCRYPTION_KEY` | `RIALTO_ACCOUNT_ENCRYPTION_KEY` | 手作業。**値はバイト単位でそのまま** |
| `CCR_HOME_DIR` | `RIALTO_HOME_DIR` | 手作業。旧名は無視される |
| `CCR_DEBUG_OAUTH` | `RIALTO_DEBUG_OAUTH` | 手作業。旧名は無視される |
| DB `ccr` / `ccr_test` | `rialto` / `rialto_test` | 手作業（`scripts/rename-dev-database.ts`） |
| `tkgling/claude-code-router` | `ghcr.io/tkgstrator/rialto` | 手作業（`compose.yaml`）。v2.78.4 以降 Docker Hub には push していない |
| `ccr_` thinking signature | `rialto_` | 移行不能。該当する会話は作り直す |
| `ccrVersion`（preset manifest） | `rialtoVersion` | 不要。manifest スキーマ自体が削除され、どちらも読まれない |
| `<CCR-SUBAGENT-MODEL>` | `<RIALTO-SUBAGENT-MODEL>` | 不要。旧綴りは受理し続ける（ただし**意味が変わった**、後述） |

---

## 1. ホームディレクトリ（自動）

初回起動時、`src/services/config/migrate-home-dir.ts` が `~/.claude-code-router` を
`~/.rialto` へ移す。

**rename ではなく copy → verify → remove である。** `fs.rename` は1ステップで済むが、
ファイルシステムをまたぐと失敗し、しかも旧パスが消える前に確かめられるものが何も残らない。
コピーして検証してから消せば、途中のどこで失敗しても原本は無傷で、運用者は何も失わない。

| 段階 | 内容 |
|---|---|
| copy | `fs.cp` は使わない。1ファイルずつ数えながらコピーする（部分コピーを「成功」と報告されると、運用者は不完全な設定で動きながら本物の設定が余り物に見える、という最悪の状態になる） |
| verify | 書いた数と、コピー先を数え直した数を突き合わせる。食い違えばコピー先を消して `failed` を返す |
| remove | 検証が通ってから旧ディレクトリを削除。削除だけ失敗した場合は新ホームは完全に使えるので、`legacyRemoved: false` を記録して**移行自体は成功扱い**にする（残骸は手で消してよい） |

**冪等条件は「移行先が既に存在すること」。** つまり `~/.rialto` が先にできてしまうと、
コピーは恒久的な no-op になる。だから `migrateHomeDir()` は `src/index.ts` の**最初の文**で
なければならない — `initDir()` でも logger の初回ファイル書き込みでも、先に `~/.rialto` を
作った時点で、運用者は無言で空の設定から始まってしまう。

**決して throw しない。** 失敗しても起動は止めず、`failed` を返してログに書く。調べる手段が
UI である以上、起動を止める方が悪い。原本は残っているので次回起動で再試行される。

`RIALTO_HOME_DIR` でホームを別の場所に固定しているときはスキップする。読まれるディレクトリが
`~/.rialto` ではない以上、そこへ移しても運用者のホームを散らかすだけだから。

### 結果の確認

起動ログを見る。

| ログ | 意味 |
|---|---|
| `Moved configuration to .rialto.` | 移行成功。旧ディレクトリも削除済み |
| `Copied configuration to .rialto, but could not remove the old directory; it is safe to delete by hand.` | 中身は移った。`~/.claude-code-router` は手で消してよい |
| `Copy to the new home directory did not verify; the original is untouched and will be retried on next boot` | 検証失敗。**原本は無傷**。次回起動で再試行される |
| `Could not copy configuration to the new home directory; ...` | コピー中の例外。部分コピーは削除済み、原本は無傷 |

何も出なければ `already-migrated`（`~/.rialto` が既にある）か `nothing-to-migrate`
（旧ディレクトリが無い）のどちらか。

### 落とし穴：Docker のバインドマウント

コンテナの中から見た旧パスは**マウントポイント**でしかないので、この移行では救えない。
ホスト側のディレクトリを1度リネームすること:

```shell
mv ccr-config rialto-config
```

そのうえで `compose.yaml` を `- ./rialto-config:/root/.rialto` に直す
（旧: `- ./ccr-config:/root/.claude-code-router`）。

---

## 2. 環境変数

### `RIALTO_ACCOUNT_ENCRYPTION_KEY` — 最も危険な1つ

**変数名を変え、値はバイト単位でそのまま維持すること。**

この鍵は既存の `SubAccount` 行を復号する。違う値を入れると、保存済みのサブスクリプション
トークンはすべて復号不能になる。設定漏れは自己説明的でないので、`encryptionKey()` は
その指示ごと throw する:

```
RIALTO_ACCOUNT_ENCRYPTION_KEY is required for SubAccount token encryption.
If you set CCR_ACCOUNT_ENCRYPTION_KEY before the rename, rename the variable
and keep the value byte-for-byte — a different value cannot decrypt existing accounts.
```

鍵の解釈は 64 桁 hex → 32 バイト base64 → それ以外は sha256 の順。**同じ文字列なら同じ鍵**に
なるので、値さえ触らなければ形式を気にする必要はない。

### `RIALTO_HOME_DIR` / `RIALTO_DEBUG_OAUTH`

どちらも旧名（`CCR_HOME_DIR` / `CCR_DEBUG_OAUTH`）は**単に無視される**。

`CCR_HOME_DIR` を設定したまま起動すると、Rialto は既定の `~/.rialto` を読む。設定が
空に見えたら、まずこれを疑うこと — 間違ったホームは「設定が空」という形で自己申告する。

`RIALTO_DEBUG_OAUTH=1` でトークン交換のログが出る（Claude / Codex 両方）。

### 新しく増えたもの

| 変数 | 用途 |
|---|---|
| `RIALTO_TRUST_LOCAL=false` | `/api/*` のローカルブラウザ免除を切る。公開運用の詳細は `docs/guides/public-deployment.md` |
| `TEST_DATABASE_URL` | テスト用 DB。未設定だと DB テストは skip される（開発 DB を truncate するよりは skip の方がよい、という判断） |

---

## 3. データベース名

新しい postgres ボリュームは `rialto` / `rialto_test` で作られる（devcontainer の initdb
スクリプト）。**リネーム前に作ったボリュームだけ**手当てが要る。

```shell
bun run scripts/rename-dev-database.ts --dry-run   # 何が起きるか見る
bun run scripts/rename-dev-database.ts             # ccr → rialto, ccr_test → rialto_test
```

`ALTER DATABASE ... RENAME TO` はデータベースの中身をすべて保つ。`_prisma_migrations` も
そのままなので、**あとから `prisma migrate` を流す必要は無い**。

このコマンドはトランザクション内で実行できず、接続が1本でも残っていると拒否される。
スクリプトは接続を terminate するので、**先に dev サーバーを止めておく**方がよい
（プールを切られたくなければ）。

リネーム後、`DATABASE_URL` と `TEST_DATABASE_URL` を新しい名前に直す。スクリプトは
何を直すべきか印字するが、`.env` を書き換えることはしない。書き換えたら:

```shell
bun run scripts/rename-dev-database.ts --verify
```

で、新しい接続先から既存の暗号化済みトークンが復号できることまで確かめられる。

---

## 4. Docker イメージ

```diff
 services:
   rialto:
-    image: tkgling/claude-code-router:latest
+    image: ghcr.io/tkgstrator/rialto:latest
```

イメージは GHCR のみに publish している。Docker Hub の `tkgling/rialto` は
v2.78.4 までのタグが残っているだけで、それ以降は更新されない。

ボリュームのパスも併せて直すこと（§1 の落とし穴を参照）:

```diff
-      - ./ccr-config:/root/.claude-code-router
+      - ./rialto-config:/root/.rialto
```

サブスクリプション認証情報のマウント（`~/.claude` / `~/.codex`）は変わっていない。Codex の
トークンはその場でリフレッシュされるので **read-write のまま**にしておくこと。

**`ccr` / `rialto` シェルコマンドは存在しない。** `package.json` に `bin` フィールドが無く、
CLI そのものが廃止された。`ccr restart` / `ccr start` を叩いていたスクリプトは
`docker compose restart` に置き換える。

---

## 5. `<CCR-SUBAGENT-MODEL>` タグ

**旧綴りは引き続き受理される。** このタグは運用者が既に書いてしまったプロンプトの中に
生きている外部契約である。受理をやめると、旧綴りのタグは除去されないままプロンプトに残って
上流へ届き、`agent` レーンで振り分けられ、Activity でもメインエージェントの呼び出しとして**無言で**記録される — しかも
リクエストの中に理由を示すものが何も残らない。リネームは名前を1つ**足した**のであって、
置き換えたのではない。

新しい綴りは `<RIALTO-SUBAGENT-MODEL>`。書き換えは任意である。

### ただし意味が変わった

```
<RIALTO-SUBAGENT-MODEL>provider,model</RIALTO-SUBAGENT-MODEL>
```

**タグの値はもう読まれない。** 読むのは**有無だけ**で、有ればそのリクエストはシナリオの
`subagent` レーンのリストで振り分けられる。モデルはタグの中身ではなくそのリストから決まるので、
サブエージェントの行き先は Routing 画面で編集できる。有無は `RequestLog.isSubagent` にも記録される。
v2.89.0 では、要求ティアのマップ（§9）にレーンが無かったため、タグは記録されるだけで何も選ばなかった。
シナリオとレーンに戻ったいま、タグは再び `subagent` レーンを選ぶ。

移行にあたって壊れるものは無い（中身に古い `provider,model` を書いたままのタグも、そのまま
除去されて subagent レーンで振り分けられる）。ただし**「タグにモデル名を書けばそこへ飛ぶ」前提は
成り立たない**。サブエージェントを別のモデルへ振りたいなら、各シナリオの `subagent` レーンの
リストにそのプロバイダ · ティアを書く。`subagent` レーンのリストに使えるルートが無ければ同じレーンの
`default` へ落ち、それも空なら呼び出し側のモデルのまま送られる — `agent` レーンのリストは借りない。

タグはルーティングモードによらず — passthrough でも — 最初に除去され、上流へは届かない。
閉じていないタグは「存在する」とは数えられるが、除去はされない。タグを読むのは Anthropic 形の
`system` の 2 番目のブロックなので、`/v1/messages` 以外の受け口のリクエストは常に `agent` レーンで
振り分けられる。

---

## 6. `ccr_` thinking signature

**移行できない。該当する会話は作り直すしかない。**

Rialto は、upstream が signature 無しの reasoning を返したとき（Gemini のストリーム変換など）
自前のプレースホルダ signature を発行する。これは Anthropic の signature ではなく、
Anthropic には検証できない。

合成 signature は**クライアントのトランスクリプトに書き込まれ、以後のターンで毎回再生される**。
現在マッチするプレフィクスは `rialto_` だけなので、リネーム前に発行された `ccr_` の
プレースホルダはそのまま Anthropic へ転送され、拒否され、**その会話は恒久的に 400 になる**。

該当する会話を新しく始め直すこと。他に手当ては無い。

（signature を持たない thinking ブロックと、Rialto が発行したプレースホルダは、どちらも
Anthropic に対しては同じく使い物にならないので落とされる。**本物の Anthropic signature は
残す** — 落とすとプロンプトキャッシュのプレフィクスが無効になり、毎ターン全コンテキストを
再課金することになる。）

---

## 7. preset manifest の `ccrVersion`

**何もしなくてよい。** `ccrVersion` / `rialtoVersion` を読んでいた manifest スキーマ
（`PresetMetadataSchema` など）は `src/schemas/domain/preset.ts` から削除された。もともと
manifest を parse するコードは無かったので、失われた互換性も無い。同ファイルに残っているのは
`JsonValueSchema`（`schemas/api/config.ts` と `schemas/domain/config.ts` の `.catchall`）だけ。

「preset」と呼ばれていた機能は全部無い — `src/shared/preset/`（CLI プリセットインストーラ）、
`src/lib/presets/` と Settings → Presets 画面、そして Routing 設定のスナップショットだった
`RoutingPreset`（§8-8）。

---

## 8. 移行後に必ず確認すること

リネームとは無関係に、v3 では挙動そのものが変わったところがある。移行直後に「動かなくなった」
と見えるのは、たいていこの節のどれかである。

### 8-1. `/v1/*` は発行済みアクセストークンのみ

**移行後、既存のクライアントは全部 401 になる。** これが最も刺さる非互換点である。

- 旧来の `APIKEY` は `/v1/*` では**受理されない**。`/api/*` でも受理されなくなった（§8-9）。
- クライアントには **Access tokens** で発行するトークンを配る。

```shell
export ANTHROPIC_AUTH_TOKEN=rialto_xxxxxxxx
```

UI を開けない場合は、**ホスト上で**資格情報ヘッダ無しに API を叩けば発行できる
（ホスト上からのリクエストは管理ゲートを免除される）:

```shell
# ホスト上で実行する
curl -s -X POST http://localhost:3456/api/access-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"claude-code"}' | jq -r .plaintext
```

平文は発行時の1回しか表示されない（保存しているのは sha256 のみ）。

### 8-2. すべての受け口が `passthrough` で始まる

面ごとの既定値は廃止され、全面が単一の初期値 `passthrough` から始まる。
つまり**移行後は `/v1/messages` もルーティングされない** — 呼び出し側の `body.model` が
そのまま使われる。

Routing 画面で `/v1/messages` を `routed` に切り替えること。詳細は
`docs/architecture/inbound-surfaces.md`。

### 8-3. シナリオは 3 つ、レーンは 2 つ

`background` シナリオはマイグレーション `20260728_router_rules_drop_background` で `default` に
畳み込まれた。`webSearch` と `image` もシナリオではなくなり（Web 検索は、実行できないルートを飛ばす
**ゲート**になった）、残ったのは `default` / `think` / `longContext` の 3 シナリオと
`agent` / `subagent` の 2 レーンである（§9）。v2.89.0 では一時的にシナリオもレーンも無くなり、要求された
モデルのティアで振り分けていたが、いまはシナリオとレーンに戻っている。**モデル名は行き先を選ばない。**
旧「haiku トラフィックを安いモデルへ」に相当する設定は、シナリオとレーンで書く — たとえば
サブエージェントに安いモデルを使わせるなら、`subagent` レーンのリストにそのプロバイダの `haiku` を
書く（ルール画面はもう無い — §8-8）。

ペルソナの `background` 除外も消えた。いまの除外は**受け口単位**で、`/v1/messages` 以外では
ペルソナが挿入されない（routed なトラフィックに限る — passthrough はルーティングごと飛ばす）。

### 8-4. weekly drain guard が無い

サブスクリプションの週次ウィンドウが線形ドレイン目標を超えたら先回りでフェイルオーバーする
挙動と、その余裕幅を調整する `Router.weeklyDrainMarginPct` は**どちらも削除された**。
設定に残っていても読まれない。

いまはサブスクリプションを上流の上限まで走らせ、実際に返ってきた 429 に反応して
サブアカウントをローテーションする。

### 8-5. bare なモデル名の扱い

`routed` な面では、モデルはシナリオとレーンのリストのルートから決まり、`body.model` は行き先を
選ばない。レーンの `default` のリストにルートが無いとき（あるいは全部 OFF のとき）、および
`passthrough` な面では、
`provider,model` を指定するのが確実
（`GET /v1/models` が返す id をそのまま使える）。bare なモデル名は、**有効な**プロバイダが
ちょうど1つだけそのモデルを提供している場合に限りそこへ解決される。0件や複数件なら送られない。

### 8-6. `CUSTOM_ROUTER_PATH` は削除された

以前は「設定は往復するが読まれない」状態だったが、いまはキー自体が退役した。ディスクに
残っていても無視され、次の保存で消える（§8-8）。カスタムルーターに依存していた判断ロジックは、
シナリオ × レーンごとのルートの並びとプロファイルの使い分けで表現する。それで表現
できないものは、いまの Rialto には無い。

### 8-7. Gemini の API キーに期限がある（Rialto 由来ではない）

**これは Rialto の変更ではなく Google 側の期限だが、放置すると Gemini が丸ごと止まるので
移行のタイミングで一緒に確認しておくこと。**

Gemini API はキーの種別を移行中で、公式ドキュメントが次の期限を示している。

| 時期 | 内容 |
|---|---|
| すでに | AI Studio で**新規に作るキーは自動的に auth key** になる |
| すでに | **unrestricted な standard key** からのリクエストは拒否される |
| **2026年9月** | **standard key** からのリクエストが拒否される |

- **standard key** — プロジェクトに課金を紐づけるだけで呼び出し元を識別しない従来のキー
- **auth key** — サービスアカウントに直接紐づき、粒度の細かいアクセス制御と漏洩時の即時失効が効く

対処は AI Studio でキーを発行し直すだけでよい（新規キーは自動的に auth key になる）。
発行後、Providers → `google` の API キーを差し替える。長く使っていないキーは
AI Studio 上で `Blocked` タグが付いているので、そこでも判別できる。

**Gemini のサブスク枠（Code Assist）は Rialto では対応していない。** Rialto から Gemini を
使う経路は `google` プロバイダの api_key だけである。理由は
`docs/plan/rialto/gemini-code-assist-spike.md` §0 にまとめてある（対象ティアが 2026-06-18 に
提供停止され、残る Code Assist Standard / Enterprise は月額シート課金で、api_key 経路に対する
利点が無いため）。

なお **無料枠と従量課金では入力データの扱いが違う**。公式の文言で、無料枠は
"Content used to improve our products"、従量課金は "Content **not** used to improve our
products" である。Rialto はゲートウェイなので**通るのは自分のコードとプロンプトそのもの**に
なる。業務コードを流すなら従量課金にしておくこと。

### 8-8. ルーティングはシナリオ別のルートと Passthrough だけになった

マイグレーション `20260910095324_drop_router_slot_and_routing_preset` で、チェーン以外の
ルーティング機構がすべて消えた。その後チェーン自体も、シナリオ × レーンごとの「プロバイダ · ティア」の
並びに置き換わった（§9）。
運用者が知っておくべきことは次のとおり。

| 項目 | 何が起きるか |
|---|---|
| `RouterSlot`（シナリオごとの primary / fallbacks / ルール） | **テーブルごと削除される。** チェーン（いまはシナリオ × レーンのルート）への自動移行は**しない** — 運用者が書いていないルートは運用者のものではないし、ルートの無いリストは呼び出し側のモデルを素通しするので、未設定のインストールとしては正しい挙動になる。旧スロットの振り先を残したければ、Routing 画面でルートとして書き直す |
| `RoutingPreset`（Routing 設定のスナップショット） | テーブル・`/api/routing-presets`・Routing 画面の Presets メニュー・組み込みプリセットがすべて消える。保存済みスナップショットは失われる |
| `longContext` の手動しきい値 | 旧 `longContext` スロットの `params.threshold` が**数値なら**、`live` プロファイルの `constraints.longContextThreshold` へ写された。v2.89.0 ではこの値は読まれなかったが、`longContext` シナリオが戻ったいまは、しきい値の調整の**出発点**として読まれる（30k〜基準値に収めて使う）。しきい値は自動になり、以後は scheduler が 1 日 1 回まで動かす。手で決める方法は無い（§9-1 / §9-4） |
| `config.json` の `Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK` | 読まれない。`POST /api/config` はこれらを警告付きで捨て、次の保存でディスクからも剥がす。`ROUTER_MODE` 系も同様 |
| `~/.rialto/<project>/` のプロジェクト単位・セッション単位の Router 上書きファイル | 読まれない。`rialto.json` も `claude-code-router.json` も無視される。プロジェクトごとに違うモデルを当てたいなら、アクセストークンを分けてそれぞれ別のプロファイルに固定する |
| アクティブなペルソナ | `Router.persona` ではなく、トップレベルの `ActivePersona` キー（ディスクと `/api/config` の両方）。ディスク上の値はもともと `ActivePersona` だったので、設定の書き換えは要らない |
| 認証モードをまたぐフォールバック | **auth_mode ゲートが無くなった。** あるリストで subscription の後ろに api_key を書いてあれば、そのとおりに落ちる。以前はゲートが黙って落としていた並びが、いまは実際に走る — 従量課金へこぼしたくないなら、そのルートを外すこと |
| 無効化した Provider / Model | どの経路からも送られない。ルートの解決先（エイリアスが指すモデル）が無効なら飛ばされ、passthrough で `provider,model` を手で指定しても拒否され、無効化したサブスクリプションプロバイダのアカウントは候補にならない。以前は chain の entry と passthrough の指定が無効化を素通りしていた |
| リストに使えるルートが無いとき | `think` / `longContext` のリストに使えるルートが無ければ、同じレーンの `default` のリストで振り分ける。`default` のリストにルートが 1 本も無い、または全部 OFF なら呼び出し側の `body.model` がそのまま通る（429 にはならない）。クォータか健全性で止められたルートがあったときだけ、プロファイルの `exhaustedBehavior`（既定 `'429'`）に従う。エイリアス未設定・Web 検索不可・プロンプトが入らない、で全ルートが落ちたときは 400（待っても答えが変わらないので 429 にはしない） |

移行後にまずやること: Routing 画面でシナリオ × レーンのルートを確かめ（ルートが指すプロバイダの
ティアエイリアスはプロバイダのページで確かめる）、受け口を `routed` に切り替える。それまでは
全リクエストが呼び出し側のモデルで素通しされる。旧チェーンがあったなら、§9 の backfill が
変換済みである。

### 8-9. `APIKEY`（管理キー）は削除された

`/api/*` の bootstrap token / 緊急脱出キーだった envelope の `APIKEY` は**無くなった**。
`/api/*` を通れるのは、ホスト上からのリクエスト（ローカル免除）と、検証済みの Cloudflare Access
assertion の 2 つだけである。

| 既存インストールで起きること | 対処 |
|---|---|
| 設定済みの `APIKEY` が効かなくなる。`config.json` の値は無視され、次の保存で消える（`POST /api/config` が警告を出す）。環境変数の `APIKEY` も読まれない | 不要（手で消してもよい） |
| リモートから `X-API-Key` / `Authorization: Bearer` で `/api/*` を叩いていたクライアントやスクリプトは **401** になる | Access 経由にするか、ホスト上で実行する（ホスト上からなら資格情報ヘッダは要らない） |

理由: Access を迂回できる `/api/*` のマスターキーであり、`config.json`・バックアップ・シェル履歴から
読み取った者なら誰でも使えた。それを残していた理由の障害には、秘密を要らない入り直し方が既にある。

締め出されたとき（Access の障害や設定ミス、`config.json` の退避、Postgres の停止）は、ホストへ SSH して
ポートを転送し、手元のブラウザで `http://localhost:3456` を開く:

```shell
ssh -L 3456:localhost:3456 <host>
```

ホスト上からのリクエストは免除され、その判定は Access も DB も読まない。Docker ではポートをホストに
publish しておくこと（ループバックで足りる）。`RIALTO_TRUST_LOCAL=false` で免除を切っていて Access も
未設定なら `/api/*` には何も届かない（起動時に警告が出る）。詳細は `docs/guides/public-deployment.md`。

---

## 9. チェーンからシナリオ × プロバイダ tier へ

ルーティングは、**シナリオ × レーンごとの具体的なモデルの並び（チェーン）**から、
**シナリオ × レーンごとの「プロバイダ · ティア」の並び**に作り直された。チェーンのエントリは
`Model` 行を直接指していたので、ベンダーが新モデルを出すたびに、そのモデルを使いたいエントリを
全部張り替える必要があった。いまのルートはモデルを名指ししない — 「このプロバイダの sonnet」と
だけ書き、それがどのモデルかはプロバイダのティアエイリアスが決める。シナリオとレーンは
チェーンのときのまま残り、変わったのは各行が持つものだけである。

**v2.89.0 は途中の段階だった。** v2.89.0 は同じ「プロバイダ · ティア」の考え方を、キーごと
**要求ティア**（呼び出し側のモデル名が示す `fable` / `opus` / `sonnet` / `haiku` / `other`）に
替えて入れた（ティアマップ）。運用者が求めていたのはシナリオの振り分けはそのままに中身だけを
替えることで、キーまで替える必要は無かった。しかも変換は `default` / `agent` のチェーンしか
読まなかったので、`think` / `longContext` / subagent のリストは消え、Opus 指定の要求が Sonnet に
回るようになった。いまのビルドはシナリオ × レーンに戻し、旧チェーンを**もう一度**、今度は全レーン
分変換する（§9-3）。旧チェーンがまだ DB に残っているのは、それを消す v2.89.0 の縮退マイグレーション
（#535）を #540 で取り消したからである。

仕組みのリファレンスは [routing.md](../architecture/routing.md)、決定の理由と経緯は
[scenario-tier-routing.md](../plan/scenario-tier-routing.md) にある。v2.89.0 の計画は
[quota-and-tier-routing.md](../plan/quota-and-tier-routing.md) に記録として残っている。

### 9-1. 運用者から見て何が変わるか

| 項目 | チェーン | いま |
|---|---|---|
| 何を書くか | シナリオ × レーンごとに、モデル（`provider,model`）の並び | シナリオ（`default` / `think` / `longContext`）× レーン（`agent` / `subagent`）ごとに、「プロバイダ · ティア」の並び。`webSearch` / `image` のリストは無い |
| どのモデルか | エントリがモデルを直接指す | プロバイダのティアエイリアス（`ProviderTierAlias`）が決める。**プロバイダのページで編集する** — モデル表と新モデルを見つける Refresh がそこにあり、エイリアスはプロファイルをまたいだプロバイダの属性でもあるため |
| 新モデルが出たとき | そのモデルを使いたいエントリを全部張り替える | エイリアスを 1 つ動かす。**自動では動かない** — catalog の Refresh は候補（`isNew`）を示すだけで、ピッカーで選んで保存（昇格）すると、そのモデルも同時に有効になる |
| ティアの置換 | `allowEscalation` / `allowDemotion` のゲート（とそれを補う `tierFallback`） | 無い。リストに書いたプロバイダ · ティアがそのまま使われる。ゲートに隠れた置換は、理由の見えない拒否を生んでいた |
| 並び順 | 書いた順 | 書いた順。ただしゲートを通ったルートは scheduler の**ペース**で前後する — このペースならリセット時点で予算の 60 % 未満しか使わないルートは先頭へ（余った Fable を捨てないため）、100 % を超えるルートは末尾へ（下に書いたルートが先に使われる） |
| Long context のしきい値 | 手で書く `longContextThreshold`（無ければ自動） | 自動。`default` / `agent` の先頭の使えるルートのモデルのコンテキスト長の 70 %（解決できなければ 128k）を基準に、scheduler が `longContext` / `agent` の先頭ルートのペースを見て 1 日 1 回まで ±20 % 動かす（範囲は 30k〜基準値）。**手で決める方法は無い**（API の保存も tuner の値を DB から引き継ぐ）。止めるだけなら `constraints.autoTuneLongContext = false`（画面には無い） |
| 制約 | `exhaustedBehavior`・`longContextThreshold`・ティアゲート・scheduler の重みの knob など | `exhaustedBehavior` / `quotaSkipPct` / `errorRateSkipPct` / `minHealthSamples` の 4 つと、しきい値の tuner の状態。引退したキーが JSONB に残っていても読まれない。画面には出ない |
| API | `/api/router-preferences` / `/api/router-utilization` / `/api/solver-input` | `/api/routing/profiles`・`/api/routing/profiles/{key}`・`/api/tier-aliases`・`/api/providers/{name}/tier-aliases/{tier}`。旧 API は削除された |
| 画面 | シナリオのタブと Agent / Subagent の切り替え、各エントリのモデル・状態・クォータ | シナリオ × Agent / Subagent の 1 つの表。各セルにプロバイダとティアのバッジを並べ、ON / OFF・並べ替え・削除ができる。追加と変更は「プロバイダ → ティア」の 2 段のダイアログで、モデルの無いティアは選べない。モデル名・状態・クォータ・制約は出さない |

変わらないもの: プロファイル（`RouterPreferenceProfile`、既定は `live`）、受け口と
アクセストークンの `profileKey`、予約キー `passthrough`、受け口ごとの routed / passthrough。

Claude サブスクのプリセットは、プロバイダのモデルが作られたとき（プロバイダの追加時と catalog の
Refresh 時）に、`defaultEnabledModels` のうち名前がそのティアを示す最初のモデルで、未設定の
ティアにエイリアスが付く。既存のエイリアスは触らない。Codex など、モデル名が Claude の系列を
示さないプロバイダには付かないので、プロバイダのページで設定すること。ピッカーは名前が
一致した候補だけでなく、そのプロバイダの全モデルを出す。

### 9-2. 挙動が変わる点

| 項目 | チェーン（v2.89.0 より前） | v2.89.0 | いま |
|---|---|---|---|
| 振り分けのキー | シナリオ × レーン | 要求モデルのティア（`other` を含む 5 つ） | シナリオ × レーン。**モデル名は行き先を選ばない** |
| シナリオの決め方 | サイズ → Web 検索 → thinking → effort / ティア | 無し | 入力がしきい値を超える → `longContext`、thinking がある → `think`、それ以外 → `default`。effort は見ない |
| サブエージェントのタグ | `subagent` レーンを選ぶ | 記録されるだけ | `subagent` レーンを選ぶ（§5） |
| Web 検索 | `webSearch` シナリオのレーンへ振る | 実行できないルートを飛ばすゲート | 同じくゲート |
| 画像 | `image` シナリオ | 無し | 無し。いまのモデルはどれも画像を読める |
| 長い入力 | しきい値（手動、無ければ自動）で `longContext` へ | コンテキスト窓のゲートだけ | 自動で調整されるしきい値で `longContext` へ。振り分けた先でもコンテキスト窓のゲートが効き、どのルートにも入らなければ 400 |
| 使えるルートの無いリスト | `default` へ落ちる | 素通し | `think` / `longContext` は同じレーンの `default` へ落ちる。`default` も空か全部 OFF なら素通し |
| 同じプロバイダの `[opus-4-8, opus-4-7]` | 順に試す | 1 本のルート | 1 本のルート（同じプロバイダ・同じティアは同じエイリアスに解決される） |
| 設定の不一致 | 偽の 429 になる（ティアゲートで全滅、全エントリ OFF、全候補でコンテキスト不足） | 429 はクォータか健全性で止められたときだけ。エイリアス未設定・Web 検索不可・プロンプトが入らないは 400 | 同じ |
| クォータのペース | scheduler の重み（リクエスト経路は 0 かどうかしか見なかった） | 使わない | ゲートを通ったルートの並べ替えと、Long context のしきい値の調整に使う |
| クォータのゲートの対象 | `live` のチェーンの対象だけ | 有効なサブスクプロバイダの有効なモデルすべて（どのプロファイルのルートにも効く） | 同じ |
| scheduler が書くもの | エントリごとの重み（`RoutingWeightChange`） | ターゲットごとのクォータの読み（使い切ったか・残り・リセット時刻） | それに加えてペースの見込み（`projectedPct`）と、プロファイルの `constraints` のしきい値 |
| `RequestLog.scenario` | シナリオ | 要求ティアか `passthrough`（Activity の列名は「Route」） | シナリオ（`default` へ落ちたなら `default`）か `passthrough`。Activity の列名は「Scenario」に戻った。過去の行はそれぞれのビルドが書いた値のまま |

### 9-3. 変換（backfill）が変換するもの

**マイグレーション。** `20260925010000_key_tier_routes_by_scenario` が、v2.89.0 が要求ティアで
書いた `TierRoute` の行を**すべて消し**（要求ティアはシナリオにならないので写せない）、テーブルの
キーを `scenario` と `lane` に替え、**全プロファイルの `chainBackfilledAt` を NULL に戻す**。
`ProviderTierAlias` には触らない。

**いつ走るか。** `db seed`（`src/prisma/seed.ts`）が
`src/services/routing-migration/backfill-tier-routes.ts` を呼ぶ。コンテナでは `entrypoint.sh` が
`migrate deploy` の後に毎回 `db seed` を流すので、新しいイメージの初回起動で走る（ローカルでは
`bun run db:seed`）。`RouterPreferenceProfile.chainBackfilledAt` の印でプロファイルごとに
**1 回だけ**。すでにルートを持つプロファイル（運用者が先に書いたもの）は変換せず、印だけ付ける。
`live` を最初に処理するので、既定のプロファイルがエイリアスを先に取り、ほかのプロファイルはそれを
通して解決される。

**失敗したら起動しない。** プロファイルごとのトランザクションなので、失敗より前のプロファイルは
変換されて印が付き、失敗したプロファイルは旧チェーンのまま残る。そのうえで例外は握りつぶさず、
seed が非 0 で終わり、`entrypoint.sh` の `set -e` がコンテナを止める。握りつぶして続けると、その
プロファイルだけルートが無い — つまり全リクエストが素通しになる — まま新しいビルドが**正常に**
起動してしまうからである。

変換は純粋関数 `src/services/routing-migration/plan-tier-routes.ts` が決める:

| 旧チェーン | いま |
|---|---|
| `default` / `think` / `longContext` の、`agent` と `subagent` の各リスト | **同じシナリオ・同じレーンのリスト**になる。順序はチェーンの priority のまま（リストごとに 1 から振り直す） |
| エントリ | そのプロバイダの、モデル自身のティア（`Model.manualTier`、無ければ名前）のルートになる。**ON / OFF はエントリのまま** — ティアゲートの変換はもう無い。モデルやプロバイダの OFF はリクエストのたびに読むので、ルートには写さない |
| エントリのモデル | そのプロバイダのそのティアのスロットが空いていれば、エイリアスになる。1 つのスロットを複数のエントリが取り合うときは「名前がティアを示すモデル → エントリ・モデル・プロバイダがすべて有効なもの → リストの順（`default` / `agent` が先）→ priority → 非 deprecated → 名前」の順で決める。**既存のエイリアスは上書きしない** — ほかのプロファイルが取ったもの、プリセットが付けたもの、v2.89.0 で運用者が付けたものが勝ち、ルートは別のモデルに解決されることがある（notes に出る） |
| 名前が Claude の系列を示さないモデル（Codex の `gpt-*` など） | そのプロバイダでそのモデルをすでに指しているスロットがあればそれ、無ければ sonnet / opus / haiku / fable のうち空いている最初のスロットにエイリアスされる。空きが無ければ sonnet のルートになり、sonnet が指す別のモデルに解決される（notes に出る） |
| 同じリストで同じプロバイダ・同じティアに解決されるエントリ | 1 本のルートにまとまる。後ろのエントリが ON で前のルートが OFF だったなら、ON にして後ろの位置に置く（チェーンで実際に使われていた位置） |
| `webSearch` / `image` のリスト | 変換しない。件数だけ notes に残る |

変換の差分 — まとめたもの、別のモデルに解決されるようになったもの、変換しなかったリストの件数 — は、
すべて notes として seed のログ（`[tier-routes] converted the chain into scenario routes`）に出る。
**移行後に必ず目を通すこと。** チェーンが空だったプロファイルはルートの無いプロファイルになる
（= そのプロファイルでは全部素通し）。

### 9-4. 戻らないもの・引き継がれるもの

- **v2.89.0 のティアマップ画面での編集は戻らない。** 要求ティアで書いたルートは、マイグレーションが
  消す行そのものである（キーが違うので写せない）。v2.89.0 で Routing を編集していたなら、その意図を
  シナリオ × レーンのリストに入れ直すこと。
- **v2.89.0 で設定したエイリアスは残る。** マイグレーションはエイリアスに触らず、変換は既存の
  エイリアスを上書きしないので、プロバイダのページで選んだモデルがそのまま使われる。
- **`webSearch` / `image` のリスト。** シナリオではなくなった。Web 検索付きのリクエストは、各リストの
  ルートのうち Web 検索を実行できるものに絞られる — Web 検索を使うなら、Chat Completions 以外の形で
  送るルートがリストにあるか確かめること。
- **しきい値。** 旧チェーンの時代に手で設定した `constraints.longContextThreshold` が JSONB に
  残っていれば、それが tuner の現在値として読まれる（30k〜基準値に収めて使う）。以後は tuner が
  1 日 1 回まで動かす。残っていなければ基準値（自動）から始まる。
- **scheduler の重み。** 変換する対象ではなく、計算そのものが無くなった（§9-2）。

### 9-5. やり直すとき（ロールバック中に編集した場合）

印の付いたプロファイルは二度と変換されない。一方、v2.89.0 より前のイメージに戻している間の
Routing 画面の編集は旧チェーン（`RouterPreferenceEntry`）にしか入らない。そのため**ロールバック中は
Routing を編集しない**のが運用上の決まりである。やむを得ず旧チェーンを編集したら、新しいイメージに
戻す前に:

```shell
bun run scripts/rebackfill-tier-routes.ts --profile <key>
bun run db:seed        # コンテナなら、次の起動で entrypoint.sh が流す
```

スクリプトはそのプロファイルの `TierRoute` を消して印を外すだけで、次の `db seed` が旧チェーンから
変換し直す。エイリアスは触らない — backfill は既存のエイリアスを上書きしないので、その間に
プロバイダのページで変えたエイリアスも保たれる。

v2.89.0 のイメージへ戻すことは想定していない。v2.89.0 は `TierRoute` の要求ティアの列
（`requestedTier`）を読むが、`20260925010000` がその列を消しているので、ルートを読み込めない。

### 9-6. 旧テーブルが消えるのは次のリリース

この移行は expand / contract の 2 段で進める。いまのリリースは旧チェーン（`RouterPreferenceEntry`）・
`RoutingWeightChange`・`ScenarioKey` / `RouterPreferenceKind` の enum・`Model.manualTier`・印の
`chainBackfilledAt` をスキーマに残している（backfill とエイリアスの候補一覧はまだ `Model.manualTier`
を読む。画面と PATCH からはすでに消えた）。v2.89.0 の後にそれらを消す縮退マイグレーション（#535）が
一度マージされたが、旧チェーンを全レーン分変換し直すために #540 で取り消した。縮退マイグレーションは、
このビルドが本番で一度起動し、全プロファイルに印が付いてから出し直す — 旧チェーンを変換する機会を
飛ばさないためである。

---

## 10. チェックリスト

- [ ] `~/.claude-code-router` が消え、`~/.rialto` に設定が入っていることを起動ログで確認した
- [ ] Docker の場合、ホスト側ディレクトリを `mv` し、`compose.yaml` のイメージ名とボリュームパスを直した
- [ ] `RIALTO_ACCOUNT_ENCRYPTION_KEY` を**同じ値**で設定し、Providers 画面でサブスクリプションアカウントが正常に見えることを確認した
- [ ] `CCR_HOME_DIR` / `CCR_DEBUG_OAUTH` を使っていたなら新名に直した
- [ ] `bun run scripts/rename-dev-database.ts` を流し、`DATABASE_URL` / `TEST_DATABASE_URL` を更新し、`--verify` が通った
- [ ] Access tokens でアクセストークンを発行し、クライアントの `ANTHROPIC_AUTH_TOKEN` を差し替えた
- [ ] リモートから `X-API-Key` で `/api/*` を叩くスクリプトがあれば、Access 経由かホスト上での実行に置き換えた（`APIKEY` は削除された — §8-9）
- [ ] Routing 画面で各シナリオ × レーンのルートを確かめ、使っている受け口を `routed` に切り替えた（旧 RouterSlot の振り先は自動では移らない — §8-8）
- [ ] 旧チェーンがあったなら、seed のログの backfill の notes を読み、別のモデルに解決されるようになったルートと、変換されなかった `webSearch` / `image` のリストを確かめた（§9-3 / §9-4）
- [ ] v2.89.0 のティアマップ画面で Routing を編集していたなら、その内容をシナリオ × レーンのリストに入れ直した（要求ティアのルートは戻らない — §9-4）
- [ ] Routing 画面の Long context の行で、しきい値が意図した大きさか確かめた（自動。旧チェーンの手動値が残っていれば、それが調整の出発点になる — §9-4）
- [ ] 各プロバイダのページで、ティアエイリアスが意図したモデルを指していることを確認した（Codex など、モデル名が Claude の系列を示さないプロバイダには自動では付かない — §9-1）
- [ ] ルートで subscription の後ろに api_key を並べている箇所が、本当にそう落としてよい並びか確認した（auth_mode ゲートは無い）
- [ ] `~/.rialto/<project>/` のプロジェクト別 Router 上書きファイルに頼っていたなら、アクセストークン × プロファイルで置き換えた
- [ ] `ccr restart` などを叩くスクリプトを `docker compose restart` に置き換えた
- [ ] Gemini を使っているなら、AI Studio の API キーが auth key であることを確認した（standard key は 2026年9月に拒否される — §8-7）

## 関連

- `docs/guides/public-deployment.md` — トンネル越しの公開と Cloudflare Access
- `docs/architecture/inbound-surfaces.md` — 受け口と routingMode
- `docs/architecture/routing.md` — シナリオ × プロバイダ tier のルーティング（ゲート・ペース・結果・しきい値・クォータの snapshot・変換）
- `docs/plan/scenario-tier-routing.md` — シナリオ × プロバイダ tier への作り直しと、その理由
- `docs/plan/quota-and-tier-routing.md` — v2.89.0 の要求ティアのマップの計画（記録として残してある）
- `README_ja.md` — 設定リファレンス
