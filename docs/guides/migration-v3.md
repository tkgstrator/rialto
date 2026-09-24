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
上流へ届き、Activity でもメインエージェントの呼び出しとして**無言で**記録される — しかも
リクエストの中に理由を示すものが何も残らない。リネームは名前を1つ**足した**のであって、
置き換えたのではない。

新しい綴りは `<RIALTO-SUBAGENT-MODEL>`。書き換えは任意である。

### ただし意味が変わった

```
<RIALTO-SUBAGENT-MODEL>provider,model</RIALTO-SUBAGENT-MODEL>
```

**タグの値はもう読まれない。** 読むのは**有無だけ**である。v3 の途中まではその有無がシナリオの
`subagent` レーンを選んでいたが、ティアマップ（§9）にはレーンが無い。いまは
`RequestLog.isSubagent` に記録されるだけで、**ルートは何も選ばない**。サブエージェントの
リクエストも、自分が送ったモデル名のティアでほかのリクエストと同じようにルーティングされる。

移行にあたって壊れるものは無い（中身に古い `provider,model` を書いたままのタグも、そのまま
除去されて記録される）。ただし**「タグにモデル名を書けばそこへ飛ぶ」前提も、「サブエージェントは
専用レーンのモデルへ行く」前提も成り立たない**。サブエージェントを別のモデルへ振りたいなら、
サブエージェント側が要求するモデル（のティア）を変え、そのティアのルートを Routing 画面に書く。

タグはルーティングモードによらず — passthrough でも — 最初に除去され、上流へは届かない。
閉じていないタグは「存在する」とは数えられるが、除去はされない。

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

### 8-3. シナリオもレーンも無い

`background` シナリオはマイグレーション `20260728_router_rules_drop_background` で `default` に
畳み込まれ、残った `default` / `think` / `longContext` / `webSearch` / `image` の5シナリオと
`agent` / `subagent` の2レーンも、ティアマップへの移行（§9）で無くなった。リクエストは自分が
要求したモデルのティアでルーティングされ、サイズ・Web 検索・健全性は各ルートの**ゲート**に
なった。旧「haiku トラフィックを安いモデルへ」に相当する設定は、`haiku` ティアのルートとして
書く（ルール画面はもう無い — §8-8）。

ペルソナの `background` 除外も消えた。いまの除外は**受け口単位**で、`/v1/messages` 以外では
ペルソナが挿入されない（routed なトラフィックに限る — passthrough はティアマップごと飛ばす）。

### 8-4. weekly drain guard が無い

サブスクリプションの週次ウィンドウが線形ドレイン目標を超えたら先回りでフェイルオーバーする
挙動と、その余裕幅を調整する `Router.weeklyDrainMarginPct` は**どちらも削除された**。
設定に残っていても読まれない。

いまはサブスクリプションを上流の上限まで走らせ、実際に返ってきた 429 に反応して
サブアカウントをローテーションする。

### 8-5. bare なモデル名の扱い

`routed` な面では、モデルは `body.model` のティアとティアマップのルートから決まる。その
ティアにルートが無いとき（あるいは全部 OFF のとき）、および `passthrough` な面では、
`provider,model` を指定するのが確実
（`GET /v1/models` が返す id をそのまま使える）。bare なモデル名は、**有効な**プロバイダが
ちょうど1つだけそのモデルを提供している場合に限りそこへ解決される。0件や複数件なら送られない。

### 8-6. `CUSTOM_ROUTER_PATH` は削除された

以前は「設定は往復するが読まれない」状態だったが、いまはキー自体が退役した。ディスクに
残っていても無視され、次の保存で消える（§8-8）。カスタムルーターに依存していた判断ロジックは、
ティアマップ（要求ティアごとのルートの並び）とプロファイルの使い分けで表現する。それで表現
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

### 8-8. ルーティングは Tier map と Passthrough だけになった

マイグレーション `20260910095324_drop_router_slot_and_routing_preset` で、チェーン以外の
ルーティング機構がすべて消えた。その後チェーン自体もティアマップに置き換わった（§9）。
運用者が知っておくべきことは次のとおり。

| 項目 | 何が起きるか |
|---|---|
| `RouterSlot`（シナリオごとの primary / fallbacks / ルール） | **テーブルごと削除される。** チェーン（いまはティアマップ）への自動移行は**しない** — 運用者が書いていないルートは運用者のものではないし、ルートの無いティアは呼び出し側のモデルを素通しするので、未設定のインストールとしては正しい挙動になる。旧スロットの振り先を残したければ、Routing 画面でティアマップのルートとして書き直す |
| `RoutingPreset`（Routing 設定のスナップショット） | テーブル・`/api/routing-presets`・Routing 画面の Presets メニュー・組み込みプリセットがすべて消える。保存済みスナップショットは失われる |
| `longContext` の手動しきい値 | 旧 `longContext` スロットの `params.threshold` が**数値なら**、`live` プロファイルの `constraints.longContextThreshold` へ写された。ただし `longContext` シナリオはティアマップへの移行で無くなったので、**この値はもう読まれない**（constraints の JSONB に残っていても無視される）。大きすぎるプロンプトは、コンテキスト窓のゲートで次のルートへ回る（§9-2） |
| `config.json` の `Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK` | 読まれない。`POST /api/config` はこれらを警告付きで捨て、次の保存でディスクからも剥がす。`ROUTER_MODE` 系も同様 |
| `~/.rialto/<project>/` のプロジェクト単位・セッション単位の Router 上書きファイル | 読まれない。`rialto.json` も `claude-code-router.json` も無視される。プロジェクトごとに違うモデルを当てたいなら、アクセストークンを分けてそれぞれ別のプロファイルに固定する |
| アクティブなペルソナ | `Router.persona` ではなく、トップレベルの `ActivePersona` キー（ディスクと `/api/config` の両方）。ディスク上の値はもともと `ActivePersona` だったので、設定の書き換えは要らない |
| 認証モードをまたぐフォールバック | **auth_mode ゲートが無くなった。** あるティアのルートで subscription の後ろに api_key を書いてあれば、そのとおりに落ちる。以前はゲートが黙って落としていた並びが、いまは実際に走る — 従量課金へこぼしたくないなら、そのルートを外すこと |
| 無効化した Provider / Model | どの経路からも送られない。ルートの解決先（エイリアスが指すモデル）が無効なら飛ばされ、passthrough で `provider,model` を手で指定しても拒否され、無効化したサブスクリプションプロバイダのアカウントは候補にならない。以前は chain の entry と passthrough の指定が無効化を素通りしていた |
| ティアに使えるルートが無いとき | ルートが 1 本も無い、または全部 OFF なら呼び出し側の `body.model` がそのまま通る（429 にはならない）。クォータか健全性で止められたルートがあったときだけ、プロファイルの `exhaustedBehavior`（既定 `'429'`）に従う。エイリアス未設定・Web 検索不可・プロンプトが入らない、で全ルートが落ちたときは 400（待っても答えが変わらないので 429 にはしない） |

移行後にまずやること: Routing 画面で使う要求ティアのルートを書き（ルートが指すプロバイダの
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

## 9. チェーンからティアマップへ

ルーティングは、**シナリオ × レーンごとの具体的なモデルの並び（チェーン）**から、
**要求ティア → (プロバイダ, ティア) の表（ティアマップ）**に作り直された。チェーンのエントリは
`Model` 行を直接指していたので、ベンダーが新モデルを出すたびに、そのモデルを使いたいエントリを
全部張り替える必要があった。ティアマップのルートはモデルを名指ししない — 「このプロバイダの
sonnet」とだけ書き、それがどのモデルかはプロバイダのティアエイリアスが決める。

仕組みのリファレンスは [routing.md](../architecture/routing.md)、決定の理由と経緯は
[quota-and-tier-routing.md](../plan/quota-and-tier-routing.md) にある。

### 9-1. 運用者から見て何が変わるか

| 項目 | チェーン | ティアマップ |
|---|---|---|
| 何を書くか | シナリオ × レーンごとに、モデル（`provider,model`）の並び | 要求ティア（`fable` / `opus` / `sonnet` / `haiku` / `other`）ごとに、「プロバイダ · ティア」の並び。要求ティアは `body.model` の名前から決まり、Claude の系列を含まない名前は `other` |
| どのモデルか | エントリがモデルを直接指す | プロバイダのティアエイリアス（`ProviderTierAlias`）が決める。**プロバイダのページで編集する** — モデル表と新モデルを見つける Refresh がそこにあり、エイリアスはプロファイルをまたいだプロバイダの属性でもあるため |
| 新モデルが出たとき | そのモデルを使いたいエントリを全部張り替える | エイリアスを 1 つ動かす。**自動では動かない** — catalog の Refresh は候補（`isNew`）を示すだけで、ピッカーで選んで保存（昇格）すると、そのモデルも同時に有効になる |
| ティアの置換 | `allowEscalation` / `allowDemotion` のゲート（とそれを補う `tierFallback`） | 表にルートとして明示する（`haiku → claude-code · sonnet`）。ゲートに隠れた置換は、理由の見えない拒否を生んでいた |
| 制約 | `exhaustedBehavior`・`longContextThreshold`・ティアゲート・scheduler の重みの knob など | `exhaustedBehavior` / `quotaSkipPct` / `errorRateSkipPct` / `minHealthSamples` の 4 つだけ。引退したキーが JSONB に残っていても読まれない |
| API | `/api/router-preferences` / `/api/router-utilization` / `/api/solver-input` | `/api/routing/profiles`・`/api/routing/profiles/{key}`・`/api/tier-aliases`・`/api/providers/{name}/tier-aliases/{tier}`。旧 API は削除された |

変わらないもの: プロファイル（`RouterPreferenceProfile`、既定は `live`）、受け口と
アクセストークンの `profileKey`、予約キー `passthrough`、受け口ごとの routed / passthrough。

Claude サブスクのプリセットは、プロバイダのモデルが作られたとき（プロバイダの追加時と catalog の
Refresh 時）に、`defaultEnabledModels` のうち名前がそのティアを示す最初のモデルで、未設定の
ティアにエイリアスが付く。既存のエイリアスは触らない。Codex など、モデル名が Claude の系列を
示さないプロバイダには付かないので、プロバイダのページで設定すること。ピッカーは名前が
一致した候補だけでなく、そのプロバイダの全モデルを出す。

### 9-2. 挙動が変わる点

| 以前 | いま |
|---|---|
| サブエージェントのタグが `subagent` レーンを選ぶ | タグは記録されるだけ。サブエージェントも自分が要求したティアに従う（§5） |
| `webSearch` シナリオのレーンへ振る | Web 検索ツール付きのリクエストは、それを実行できるルートだけに絞られる。Anthropic・Responses・Gemini の形で送るルートは可、Chat Completions の形で送るルートは不可（判定はトランスフォーマーチェーンと同じ apiStyle で行う） |
| しきい値を超えたら `longContext` のレーンへ振る | しきい値は無い。コンテキスト窓に入らないルートを飛ばして次のルートへ回る。**どのルートにも入らなければ 400** |
| 重い opus の要求や thinking の要求を `longContext` / `think` のレーンのモデルへ回す | **無くなった。** backfill は default / agent だけを読むので再現しない（§9-4）。必要ならそのティアのルートとして手で書く |
| 同じプロバイダの `[opus-4-8, opus-4-7]` を順に試す | 同じプロバイダ・同じティアは同じエイリアスに解決されるので、1 本のルートにまとまる |
| 設定の不一致が偽の 429 になる（ティアゲートで全滅、全エントリ OFF、全候補でコンテキスト不足） | 429 はクォータか健全性で止められたときだけ。ルートが無い・全部 OFF は素通し、エイリアス未設定・Web 検索不可・プロンプトが入らないは 400 |
| ペースによってティアの許容範囲が広がる | 無くなった |
| クォータのゲートは `live` のチェーンの対象にしか効かない | scheduler の snapshot が有効なサブスクプロバイダの有効なモデルすべてを対象にするので、**どのプロファイルのルートにも効く** |
| scheduler がエントリごとの重みを計算し、`RoutingWeightChange` に書く | ターゲットごとのクォータの読み（使い切ったか・残り・リセット時刻）を公開するだけ。Overview の failover 欄は、重みの行の代わりに 429 と認証失敗を出す |
| `RequestLog.scenario` にシナリオが入る | 同じ列に要求ティアか `passthrough` が入る（列名は据え置き。移行前の行は旧シナリオ名のまま）。Activity の列名は「Route」 |

### 9-3. backfill が変換するもの

**いつ走るか。** `db seed`（`src/prisma/seed.ts`）が
`src/services/routing-migration/backfill-tier-routes.ts` を呼ぶ。コンテナでは `entrypoint.sh` が
`migrate deploy` の後に毎回 `db seed` を流すので、新しいイメージの初回起動で走る（ローカルでは
`bun run db:seed`）。`RouterPreferenceProfile.chainBackfilledAt` の印でプロファイルごとに
**1 回だけ**。すでにティアマップのルートを持つプロファイル（運用者が先に書いたもの）は変換せず、
印だけ付ける。`live` を最初に処理するので、既定のプロファイルがエイリアスを先に取り、ほかの
プロファイルはそれを通して解決される。

**失敗したら起動しない。** プロファイルごとのトランザクションなので、失敗より前のプロファイルは
変換されて印が付き、失敗したプロファイルは旧チェーンのまま残る。そのうえで例外は握りつぶさず、
seed が非 0 で終わり、`entrypoint.sh` の `set -e` がコンテナを止める。握りつぶして続けると、その
プロファイルだけルートが無い — つまり全リクエストが素通しになる — まま新しいビルドが**正常に**
起動してしまうからである。原因を直すか、旧イメージに戻す（マイグレーションは追加だけなので、
1 つ前のイメージでも同じ DB を読める）。

変換は純粋関数 `src/services/routing-migration/plan-tier-routes.ts` が決める:

| 旧チェーン | ティアマップ |
|---|---|
| `default` / `agent` のエントリ | **すべての要求ティア**のルートの元になる。順序はチェーンの priority のまま |
| エントリのモデル | そのプロバイダの、モデル自身のティア（`Model.manualTier`、無ければ名前）のエイリアスになる。1 つのスロットを複数のエントリが取り合うときは「変換中のティアと同じティアのエントリ → エントリ・モデル・プロバイダがすべて有効なもの → priority → 非 deprecated → 名前」の順で決める。**既存のエイリアスは上書きしない** |
| 名前が Claude の系列を示さないモデル（Codex の `gpt-*` など） | 旧ゲートはどの要求ティアにも通していたので、変換中のティアのスロット（そのモデルがすでに持っているスロットがあればそれ。`other` では sonnet / opus / haiku / fable のうち空いている最初のもの）にエイリアスされる |
| `allowEscalation` / `allowDemotion` が拒んでいたエントリ | **OFF のルート**として入る（位置は保つ） |
| nearest-tier フォールバック（`tierFallback: 'nearest'`、既定） | 再現する。許されたティアに使えるルートが 1 本も無いとき、拒まれていたルートを近いティア順（同じ距離なら安い側）に ON にする。`tierFallback: 'refuse'` のプロファイルでは OFF のまま — 使えるルートが無いので、そのティアは素通しになる（以前の偽の 429 の代わり） |
| `other` の要求 | ゲートは元々効かなかったので、チェーンでの ON / OFF のまま全エントリが入る |
| 同じプロバイダ・同じティアに解決されるエントリ | 1 本のルートにまとまる。後ろのエントリが使えて前のルートが OFF だったなら、ON にして後ろの位置に置く（チェーンで実際に使われていた位置） |

変換の差分 — OFF で入れたもの、まとめたもの、別のモデルに解決されるようになったもの、nearest で
ON にしたもの、変換しなかったレーンの件数 — は、すべて notes として seed のログ
（`[tier-routes] converted the chain into the tier map`）に出る。**移行後に必ず目を通すこと。**
チェーンが空だったプロファイルは空のティアマップになる（= そのプロファイルでは全部素通し）。

### 9-4. 意図して変換しないもの

- **`default` / `agent` 以外のレーン** — `think` / `longContext` / `webSearch` / `image` の各シナリオと、
  すべての `subagent` レーンのエントリ。件数だけが notes に残る。旧分類器はサイズ → Web 検索 →
  thinking → effort / ティアの順でリクエストを振り分けていた。effort が low / medium の opus は
  `default` に入り、thinking があれば `think` が優先され、`longContext` のレーンが空なら `default` に
  落ちた — 行き先が要求ごとに分かれるので、1 つのティアの行では再現できない。RequestLog から実際に
  使われたレーンを推定する案は複雑すぎるので採っていない。必要なら移行後にティアマップへ手で足す。
- **ペースによるティアの拡大。** 偽の 429 を塞いだ時点ですでに呼んでいなかった。
- **scheduler の重み。** 変換する対象ではなく、計算そのものが無くなった（§9-2）。

### 9-5. やり直すとき（ロールバック中に編集した場合）

印の付いたプロファイルは二度と変換されない。一方、旧イメージに戻している間の Routing 画面の編集は
旧チェーン（`RouterPreferenceEntry`）にしか入らない。そのため**ロールバック中は Routing を
編集しない**のが運用上の決まりである。やむを得ず編集したら、新しいイメージに戻す前に:

```shell
bun run scripts/rebackfill-tier-routes.ts --profile <key>
bun run db:seed        # コンテナなら、次の起動で entrypoint.sh が流す
```

スクリプトはそのプロファイルの `TierRoute` を消して印を外すだけで、次の `db seed` が旧チェーンから
変換し直す。エイリアスは触らない — backfill は既存のエイリアスを上書きしないので、その間に
プロバイダのページで変えたエイリアスも保たれる。

### 9-6. 旧テーブルが消えるのは次のリリース

この移行は expand / contract の 2 段で進める。いまのリリースは追加だけで、旧チェーン
（`RouterPreferenceEntry`）・`RoutingWeightChange`・`ScenarioKey` / `RouterPreferenceKind` の enum・
`Model.manualTier`・印の `chainBackfilledAt` はスキーマに残っている（backfill とエイリアスの候補
一覧はまだ `Model.manualTier` を読む。画面と PATCH からはすでに消えた）。後のリリース（P2-7）の
縮退マイグレーションがこれらを backfill と再変換スクリプトごと削除する。計画上、そのリリースは
ティアマップのリリースが本番で一度起動し、全プロファイルに印が付いてから出す — 旧チェーンを
変換する機会を飛ばさないためである。

---

## 10. チェックリスト

- [ ] `~/.claude-code-router` が消え、`~/.rialto` に設定が入っていることを起動ログで確認した
- [ ] Docker の場合、ホスト側ディレクトリを `mv` し、`compose.yaml` のイメージ名とボリュームパスを直した
- [ ] `RIALTO_ACCOUNT_ENCRYPTION_KEY` を**同じ値**で設定し、Providers 画面でサブスクリプションアカウントが正常に見えることを確認した
- [ ] `CCR_HOME_DIR` / `CCR_DEBUG_OAUTH` を使っていたなら新名に直した
- [ ] `bun run scripts/rename-dev-database.ts` を流し、`DATABASE_URL` / `TEST_DATABASE_URL` を更新し、`--verify` が通った
- [ ] Access tokens でアクセストークンを発行し、クライアントの `ANTHROPIC_AUTH_TOKEN` を差し替えた
- [ ] リモートから `X-API-Key` で `/api/*` を叩くスクリプトがあれば、Access 経由かホスト上での実行に置き換えた（`APIKEY` は削除された — §8-9）
- [ ] Routing 画面で使う要求ティアのルートを書き、使っている受け口を `routed` に切り替えた（旧 RouterSlot の振り先は自動では移らない — §8-8）
- [ ] 旧チェーンがあったなら、seed のログの backfill の notes を読み、変換されなかった `think` / `longContext` / `subagent` などのレーンのうち必要なものをティアマップへ手で足した（§9-3 / §9-4）
- [ ] 各プロバイダのページで、ティアエイリアスが意図したモデルを指していることを確認した（Codex など、モデル名が Claude の系列を示さないプロバイダには自動では付かない — §9-1）
- [ ] ルートで subscription の後ろに api_key を並べている箇所が、本当にそう落としてよい並びか確認した（auth_mode ゲートは無い）
- [ ] `~/.rialto/<project>/` のプロジェクト別 Router 上書きファイルに頼っていたなら、アクセストークン × プロファイルで置き換えた
- [ ] `ccr restart` などを叩くスクリプトを `docker compose restart` に置き換えた
- [ ] Gemini を使っているなら、AI Studio の API キーが auth key であることを確認した（standard key は 2026年9月に拒否される — §8-7）

## 関連

- `docs/guides/public-deployment.md` — トンネル越しの公開と Cloudflare Access
- `docs/architecture/inbound-surfaces.md` — 受け口と routingMode
- `docs/architecture/routing.md` — ティアマップ（ゲート・結果・クォータの snapshot・backfill）
- `docs/plan/quota-and-tier-routing.md` — ティアマップへの移行計画と、挙動が変わる点の一覧
- `README_ja.md` — 設定リファレンス
