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
| `tkgling/claude-code-router` | `tkgling/rialto` | 手作業（`compose.yaml`） |
| `ccr_` thinking signature | `rialto_` | 移行不能。該当する会話は作り直す |
| `ccrVersion`（preset manifest） | `rialtoVersion` | 不要。両方読める |
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
+    image: tkgling/rialto:latest
```

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
生きている外部契約であり、外すと既存のサブエージェントトラフィックが**無言で**
main-agent チェーンに落ちる — しかもリクエストの中に理由を示すものが何も残らない。
リネームは名前を1つ**足した**のであって、置き換えたのではない。

新しい綴りは `<RIALTO-SUBAGENT-MODEL>`。書き換えは任意である。

### ただし意味が変わった

```
<RIALTO-SUBAGENT-MODEL>provider,model</RIALTO-SUBAGENT-MODEL>
```

**タグの値はもう読まれない。** 読むのは**有無だけ**で、それがシナリオの `subagent` レーンを
選ぶ。実際に使われるモデルは Routing 画面のそのレーンの設定から来る。

移行にあたって壊れるものは無い（中身に古い `provider,model` を書いたままのタグも、レーン
選択としては正しく働く）。ただし**「タグにモデル名を書けばそこへ飛ぶ」という前提は成り立たない**。
サブエージェントごとに違うモデルを当てていたなら、その設定は Routing 画面の `subagent`
レーンへ移す必要がある。

タグは上流へ送る前に除去される。閉じていないタグは「存在する」とは数えられるが、除去はされない。

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

**何もしなくてよい。** `src/schemas/domain/preset.ts` の `PresetMetadataSchema` は
`rialtoVersion` と `ccrVersion` の両方を optional として受ける。

ただし正確に言うと、**その manifest スキーマを読むコードは現在1つも無い**ので、この
後方互換は現時点では理論上のものである。同ファイルで本番経路から読まれているのは
`JsonValueSchema` だけ（`schemas/api/config.ts` と `schemas/domain/config.ts` の
`.catchall`）。

`src/shared/preset/`（廃止された CLI プリセットインストーラの残骸）は削除済みで、生きている
動的入力ロジックは `src/lib/presets/` に一本化された。UI の Settings → Presets が扱う
`RoutingPreset` とは**別物**である。混同しないこと。

---

## 8. 移行後に必ず確認すること

リネームとは無関係に、v3 では挙動そのものが変わったところがある。移行直後に「動かなくなった」
と見えるのは、たいていこの節のどれかである。

### 8-1. `/v1/*` は発行済みアクセストークンのみ

**移行後、既存のクライアントは全部 401 になる。** これが最も刺さる非互換点である。

- envelope の `APIKEY` は `/v1/*` では**受理されない**。効くのは `/api/*` だけ。
- `APIKEY` は**新規インストールでは生成もされない**（以前は初回起動時に自動生成していた）。
- クライアントには **Access tokens** で発行するトークンを配る。

```shell
export ANTHROPIC_AUTH_TOKEN=rialto_xxxxxxxx
```

UI から締め出されている場合は API から直接発行できる（`APIKEY` を設定している場合）:

```shell
curl -s -X POST http://127.0.0.1:3456/api/access-tokens \
  -H "X-API-Key: $APIKEY" -H 'content-type: application/json' \
  -d '{"name":"claude-code"}' | jq -r .plaintext
```

平文は発行時の1回しか表示されない（保存しているのは sha256 のみ）。

### 8-2. すべての受け口が `passthrough` で始まる

面ごとの既定値は廃止され、全面が単一の初期値 `passthrough` から始まる。
つまり**移行後は `/v1/messages` もルーティングされない** — 呼び出し側の `body.model` が
そのまま使われる。

Routing 画面で `/v1/messages` を `routed` に切り替えること。詳細は
`docs/architecture/inbound-surfaces.md`。

### 8-3. `background` シナリオが無い

`ScenarioKey` は `default` / `think` / `longContext` / `webSearch` / `image` の5つ。
`background` はマイグレーション `20260728_router_rules_drop_background` で `default` 上の
述語ルールに畳み込まれた。旧「haiku トラフィックを安いモデルへ」の設定は、固定スロットでは
なく Rules 画面（`/routing/rules`）のルールとして生き残っている。

ペルソナの `background` 除外も消えた。いまの除外は**受け口単位**で、`/v1/messages` 以外では
ペルソナが挿入されない。

### 8-4. weekly drain guard が無い

サブスクリプションの週次ウィンドウが線形ドレイン目標を超えたら先回りでフェイルオーバーする
挙動と、その余裕幅を調整する `Router.weeklyDrainMarginPct` は**どちらも削除された**。
設定に残っていても読まれない。

いまはサブスクリプションを上流の上限まで走らせ、実際に返ってきた 429 に反応して
サブアカウントをローテーションする。

### 8-5. bare なモデル名からプロバイダを逆引きしない

`resolveByModelName` は削除された。`routed` な面では、モデルはレーンとシナリオの設定から
決まる。`passthrough` な面では `provider,model` をこちらが指定する
（`GET /v1/models` が返す id をそのまま使える）。

### 8-6. `CUSTOM_ROUTER_PATH` は動かない

エンベロープと Settings フォームには残っていて設定値も往復するが、**リクエスト時に
モジュールを読み込んで呼ぶコードが存在しない**。カスタムルーターに依存していたなら、
その判断ロジックを Rules 画面の述語（モデルティア / モデル名 glob / thinking / トークン数の
範囲 / ツール型 glob / effort）へ移すこと。

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

---

## 9. チェックリスト

- [ ] `~/.claude-code-router` が消え、`~/.rialto` に設定が入っていることを起動ログで確認した
- [ ] Docker の場合、ホスト側ディレクトリを `mv` し、`compose.yaml` のイメージ名とボリュームパスを直した
- [ ] `RIALTO_ACCOUNT_ENCRYPTION_KEY` を**同じ値**で設定し、Providers 画面でサブスクリプションアカウントが正常に見えることを確認した
- [ ] `CCR_HOME_DIR` / `CCR_DEBUG_OAUTH` を使っていたなら新名に直した
- [ ] `bun run scripts/rename-dev-database.ts` を流し、`DATABASE_URL` / `TEST_DATABASE_URL` を更新し、`--verify` が通った
- [ ] Access tokens でアクセストークンを発行し、クライアントの `ANTHROPIC_AUTH_TOKEN` を差し替えた
- [ ] Routing 画面で、使っている受け口を `routed` に切り替えた
- [ ] 旧 `background` スロットに設定していた振り先を、Rules 画面のルールとして再現した
- [ ] `ccr restart` などを叩くスクリプトを `docker compose restart` に置き換えた
- [ ] Gemini を使っているなら、AI Studio の API キーが auth key であることを確認した（standard key は 2026年9月に拒否される — §8-7）

## 関連

- `docs/guides/public-deployment.md` — トンネル越しの公開と Cloudflare Access
- `docs/architecture/inbound-surfaces.md` — 受け口と routingMode
- `README_ja.md` — 設定リファレンス
