# Rialto — 改名・機能集約・Gemini対応 マスタープラン

- Status: **Draft（モック段階で人間レビュー待ち）**
- 起点: `v2.68.3` / `develop`
- 目標リリース: `v3.0.0`（破壊的変更を含む）

---

## 1. 背景

「Claude Code Router」という名前が、いまの実体と合っていない。

- 受け口はもう `/v1/messages` だけではない。`/v1/chat/completions`・`/v1/responses`・`GET /v1/models` は**すでに実装済み**で、OpenAI互換ゲートウェイとしても動く
- しかし **ルーティング設定は `/v1/messages` にしか効かない**（§3.2）。UIのRouter系画面がすべてmessages前提に見えるのはこれが理由
- 上流(provider)側はAnthropic / OpenAI / Gemini / DeepSeekまで広がっている

「Claude Code の router」ではなく「**複数のワイヤ形式を受け、複数のベンダへ振り分けるルーティング・ゲートウェイ**」が実体である。名前を **Rialto** に変え、実体に定義を合わせる。あわせてGeminiをサブスク枠まで含めて一級市民にする。

---

## 2. ゴール / 非ゴール

### ゴール

1. 受け口を **4面 +モデル一覧** に整理し、**どの面でもルーティング設定が効く**ようにする
2. Gemini を **api_key枠・サブスク枠の両方**で対応する
3. UI を情報設計から刷新する。**モック駆動**で、実装前に人間が承認する
4. Zod スキーマを層に分ける
5. Rialto へ全面リネーム（HOME_DIR のデータ移行を含む）
6. 認証を2層にする — 管理UIは Cloudflare Access、`/v1/*` は複数発行のアクセストークン（面とルーティングプロファイルにスコープ）

### 非ゴール

- 機能削減。これは**集約**であって削減ではない
- Prisma / PostgreSQL / Hono / Vite といった基盤の入れ替え
- react-router-dom → TanStack Router のようなUI基盤の入れ替え（今回は基盤維持・設計刷新）
- 上流 `musistudio/claude-code-router` との再同期（すでに別物）

---

## 3. 現状

### 3.1 規模（`src/generated` を除く実測 / 2026-08-31）

| 領域 | ファイル | 行数 | 備考 |
|---|---:|---:|---|
| `src/components` | 111 | 17,115 | うち `ui/`(shadcn) 28ファイル。画面は15以上 |
| `src/llms` | 71 | 9,827 | transformer / pipeline / scenario-router / quota-router |
| `src/api` | 46 | 3,986 | Next.js風 `route.ts` 分割 |
| `src/schemas` | 29 | 3,718 | フラット単層 |
| `src/lib` | 40 | 3,549 | |
| `src/services` | 66 | — | config / oauth / usage / routing-scheduler ほか |
| **合計** | **396** | **49,040** | |

名称参照: `CCR` 94ファイル / `ccr` 53ファイル / `claude-code-router` 34ファイル / `Claude Code Router` 19ファイル。

### 3.2 いちばん効く歪み — ルーティングが1面にしか効かない

`src/llms/scenario-router.ts:117-128`:

```ts
// Bypass for OpenAI-compat inbound: /v1/chat/completions and
// /v1/responses callers hand-pick their target with `provider,model`
// ... Skip the whole selector, leave body.model as-is ...
if (req.inboundPath === '/v1/chat/completions' || req.inboundPath === '/v1/responses') {
  req.scenarioType = 'default'
  req.isSubagent = false
  req.resolvedFallbacks = []
```

つまり OpenAI互換で入ってきた瞬間、**シナリオ分類も・ルールスタックも・quota-aware選好チェーンも・failoverも効かない**。

結果として `RouterPreferences` / `RoutingLibrary` / `RoutingLiveEditor` / `RoutingPresetEditor` / `TierEditor` / `RouterUtilization` の6画面はすべて事実上「`/v1/messages` 専用の設定画面」になっている。これが **「UI上の機能が全部messagesだけの設定になっている」の正体**。

判断としてこのバイパス自体は当時妥当だった（OpenAI互換クライアントは自分でモデルを選ぶ前提）。問題は**それが固定で、UIから見えず、切り替えられない**こと。

### 3.3 その他の構造的な歪み

1. **Geminiの受け口が死んでいる** — `GeminiTransformer` は `endPoint = '/v1beta/models/:modelAndAction'` を宣言しているが、`src/index.ts` は `/v1/*` しかマウントしていないので到達不能。宣言だけ残った幽霊
2. **inbound面の知識が4箇所に散っている** — `errorShapeForPath`（`api/v1/error-shape.ts`）、`pickSseAggregator`（`api/v1/route.ts`）、`openaiBearerAuth` のパス列挙（`index.ts`）、`inboundType`（pipeline）。面を1つ足すたびに4箇所直す必要がある
3. **schemasが単層** — 29ファイル3,718行がフラットで、外部ワイヤ形式 / 内部API DTO / UIフォーム / 汎用ユーティリティが同居。`index.ts` の `export *` × 29 により、1つ import すると全部が読まれる（UIバンドルにサーバ専用スキーマが混入する）
4. **デッドコード** — `google-auth-library` / `fastify` / `@fastify/cors` / `fastify-plugin` が依存にあるが `src/` から一切参照されていない
5. **ドキュメントの陳腐化** — `CLAUDE.md` がまだ `packages/cli` / `packages/server` のmonorepo前提。`ccr` CLIコマンド節も残っているが `bin` フィールドはすでに無い
6. **UIの膨張** — 111コンポーネント / 17,115行 / 画面15以上。Router関連だけで5画面に分かれている
7. **命名の二重化** — `CCR` / `ccr` / `claude-code-router` / `Claude Code Router` が混在
8. **transformer選択が設定として成立していない**（§3.4）
9. **認証が単一キー** — `process.env.APIKEY` 1本で `/api/*` と `/v1/*` の両方を守っている。ローテーションすると全クライアントが同時に切れ、リクエストの帰属も取れない。管理UIと機械トラフィックは要件が違うのに同じ門を使っている

### 3.4 transformer選択の実態

登録されている transformer は `src/llms/context.ts:91` にハードコードされた**6つだけ**で、いずれも
ユーザーが選ぶ余地のないものである。

| 名前 | 束縛のされ方 |
|---|---|
| `anthropic` / `openai` / `openai-responses` / `gemini` | endpoint transformer。inbound パスで自動ディスパッチ |
| `claude-code-oauth` / `codex-oauth` | subscription 認証に紐づく |

`provider.transformer.use` は `apiStyle` + `authMode` から完全に導出できる（`apiStyleForVendor()`
が既にその写像）。加えて、この設定欄が機能していない証拠が3つある。

1. **存在しない transformer を指すシードがある** — `VENDOR_DEFAULTS.deepseek.transformer =
   { use: ['deepseek'] }`（`src/shared/data/index.ts:47`）だが `deepseek` という transformer は
   登録されていない。`resolveUseEntry` が `undefined` を返して黙って捨てられる。
   `src/providers/deepseek/` は価格スクレイパで別物
2. **options は何も設定していない** — `src/llms/registry/provider.ts:134` のコメントが
   *"The 6 shipped transformers don't take options today"* と明記している
3. **カスタムプラグイン読み込みが実装されていない** — `Transformers.tsx` は envelope の
   `transformers[]` を書くが、**それを読むコードが存在しない**。`PLUGINS_DIR` も `ensureDir`
   されるだけで一度も読まれない。この機能は外部依存 `@musistudio/llms` にあったもので、
   吸収時に実装が付いてこなかった。CLAUDE.md の記述だけが残骸として残っている

### 3.5 先に潰しておく誤解

| よくある想定 | 実際 |
|---|---|
| 「3つのAPIを実装する」 | **もう実装されている**。やるのは (a) ルーティングを効かせる (b) パリティを揃える (c) 面の知識を1箇所に集める |
| 「Gemini対応を進める」 | outbound(provider)は動いている。無いのは **inboundの有効化** と **サブスク枠** |
| 「CLIの `ccr` コマンド」 | すでに削除済み。ドキュメントだけが残骸 |

---

## 4. 目標アーキテクチャ

### 4.1 Inbound Surface レイヤ

```
                  ┌─ POST /v1/messages ─────────────── anthropic
  クライアント ───┼─ POST /v1/chat/completions ─────── openai-chat
  (Claude Code /  ├─ POST /v1/responses ────────────── openai-responses
   Codex / Gemini ├─ POST /v1beta/models/:m::action ── gemini        ★新規有効化
   CLI / SDK)     └─ GET  /v1/models ───────────────── catalog
                            │
                  ┌─────────▼──────────┐
                  │ InboundSurface     │  面ごとの知識を1つの記述子に集約:
                  │   registry         │  paths / auth / errorShape /
                  └─────────┬──────────┘  sseAggregator / inboundType /
                            │              extractModel / routingMode
                  ┌─────────▼──────────┐
                  │ Router             │  scenario → rule → preference chain
                  │  (面ごとに有効/無効) │  → quota-aware selection → failover
                  └─────────┬──────────┘
                            │
                  ┌─────────▼──────────┐
                  │ Provider transformer│ anthropic / openai / openai-responses
                  │  + pipeline        │ / gemini / *-oauth
                  └─────────┬──────────┘
                            ▼
             Anthropic / OpenAI / Google / DeepSeek / ...
```

面を1つ足す作業を「記述子を1つ足す」に落とす。これが今回の「集約」の本体である。

### 4.2 ルーティング適用モデル（新規）

各面は2つのモードのいずれかを取る。

| モード | 挙動 | 現行の該当 |
|---|---|---|
| `passthrough` | 呼び出し側が `provider,model` を指定し、そのまま上流へ | chat/completions・responses |
| `routed` | シナリオ分類 → ルール → 選好チェーン → quota-aware選択 → failover | messages |

**DB設計**: `RouterPreferenceProfile.key` を面ごとのキーとして使う。この列はもともと「将来の preference presets 用」としてスキーマコメント付きで置かれていた（現在は `key='live'` のシングルトン）。**新規テーブルなしで面ごとのプロファイルに転用できる**。

- `key='live'` → 既定プロファイル（現 messages 設定がそのまま移行）
- 面ごとに「既定を使う / 専用プロファイルを持つ」を選べる

**移行時の既定値は現行踏襲**（messages=`routed`、他=`passthrough`）。挙動は変わらず、UIから切り替えられるようになる。

---

## 5. フェーズ

順序の意図: **リネームを先に**やって以降のPRを綺麗な名前で書く / **UIモックを最初に**作って人間の承認を取り、承認済みモックを以降の実装ターゲットにする。

| Phase | 内容 | 破壊的 | 依存 |
|---|---|---|---|
| 0 | 土台整備・棚卸し | — | — |
| 1 | Rialto 全面リネーム | ✅ | 0 |
| 2 | Inbound Surface 集約 + ルーティング多面化 | 一部 | 1 |
| 3 | Gemini（inbound有効化 / api_key / サブスク枠） | — | 2 |
| 3.5 | 認証（Cloudflare Access + トークン） | 一部 | 2 |
| 4 | Zod スキーマ層分け | — | 2 |
| 5 | UI 刷新（モック駆動） | — | 2,3,4 |
| 6 | 仕上げ・v3.0.0 | — | 全部 |

**UIモックだけは Phase 0 と並行して先行作成する**（人間レビューのリードタイムを確保するため）。

---

### Phase 0 — 土台整備・棚卸し

**目的**: 以降の大規模変更を安全に回すレールを敷く。

作業:
- `CLAUDE.md` の陳腐化修正 — monorepo記述の削除、`ccr` CLIコマンド節の削除、実体（単一パッケージ / `src/` レイアウト / Hono+Vite+Prisma+Docker）への更新
- `knip` でデッドコード棚卸し。`google-auth-library` / `fastify` / `@fastify/cors` / `fastify-plugin` の削除可否を確定
- `src/providers/`（vendorスクレイパ registry）と `src/llms/registry/provider.ts`（ランタイム provider registry）の役割境界をドキュメント化。同名で別物なので混同のもと
  → **2026-09-01 に解消**: ドキュメント化ではなく**改名**した。`src/providers/` → **`src/vendors/`**。中の型は最初から `VendorProvider` / `getVendorProvider` / `scrapedVendors` と呼び分けていて、ディレクトリ名だけがそれを言っていなかった。参照は import 4行だけだった。CLAUDE.md に3者（Prisma の `Provider` 行 / ランタイム registry / vendor アダプタ）の対照表を追加
- テストのフレーク解消 — フルスイート実行時のみ `__tests__/services/config/envelope.test.ts` が8件落ちる既知の問題を切り分けて潰す
- inboundパリティ用のゴールデンフィクスチャ基盤を `__tests__/providers/__fixtures__` の仕組みの上に**inbound面別**へ拡張

完了条件:
- `bun run knip` が新規の未使用報告ゼロ
- フルスイートが安定してグリーン
- `CLAUDE.md` の記述と実装が一致

---

### Phase 1 — Rialto 全面リネーム

**目的**: 名実を一致させる。機械的置換のみの単独PRとし、ロジック変更を混ぜない（レビュー可能性の確保）。

置換マップ:

| 現在 | 新 |
|---|---|
| `Claude Code Router` | `Rialto` |
| `CCR`（識別子・コメント） | `Rialto` |
| `ccr`（変数・関数名） | `rialto` |
| `claude-code-router`（パッケージ/パス） | `rialto` |
| `CCR_HOME_DIR` | `RIALTO_HOME_DIR`（旧名は読まない） |
| `~/.claude-code-router` | `~/.rialto` |
| `tkgling/claude-code-router`（Docker） | `tkgling/rialto` |
| `@musistudio/claude-code-router`（package name） | `rialto` |
| GitHubリポジトリ `claude-code-router` | `rialto` |

**HOME_DIR移行**（最重要・唯一のデータリスク）— 実装済み:

```
起動時 migrateHomeDir():
  1. ~/.rialto が存在 → 何もしない（冪等）
  2. ~/.rialto が無く ~/.claude-code-router がある
     → コピー → ファイル数を数え直して検証 → 一致したら旧ディレクトリを削除
     → 検証に失敗したらコピー先を消す（旧ディレクトリは無傷のまま次回再試行）
  3. どちらも無い → 通常の initDir()
```

`fs.rename` ではなく **コピー→検証→削除** なのは、rename がファイルシステムを
またぐと失敗するうえ、旧パスが消える前に検証する余地が無いため。どの段階で
失敗しても旧ディレクトリは残るので、データを失わない。

注意点:
- `<CCR-SUBAGENT-MODEL>` タグは**外部契約**（ユーザーのサブエージェントプロンプトに書かれている）。`<RIALTO-SUBAGENT-MODEL>` を新名として受け付けつつ、旧タグも当面受理する
- GHCR は `ghcr.io/${{ github.repository }}` を使っているのでリポジトリ改名でイメージパスが変わる。旧パスに deprecation 用の最終タグを残す
- `~/.claude/projects/<id>/claude-code-router.json`（プロジェクト単位のルーティング上書き）も外部契約。新名 `rialto.json` を優先し旧名もフォールバック
  - **追記（2026-09、chain / passthrough 一本化）:** この上書き機構ごと廃止した。`src/llms/scenario-router/project-config.ts` と `ProjectRouterFileSchema` は削除され、`rialto.json` も `claude-code-router.json` も読まれない。上書きしていた `Router` オブジェクト自体（RouterSlot）が無くなったため、上書きする対象が無い。プロジェクトごとに振り先を変えたい用途は、アクセストークン × `profileKey` で置き換える。`docs/guides/migration-v3.md` §8-8
- Prismaのスキーマコメント / locales 3言語 / README 3言語 / `docs/**` も対象

完了条件（達成済み）:
- 残存する `claude-code-router` 参照は3か所のみ — 移行元パス定数、その移行を
  説明するコメント、そして npm 上の実際のパッケージ名（`src/services/update.ts`）
- 旧HOME_DIRを持つ環境で起動 → 設定が引き継がれる統合テストがグリーン

**旧名の受理は全廃した**（`CCR_HOME_DIR` / `CCR_ACCOUNT_ENCRYPTION_KEY` /
`CCR_DEBUG_OAUTH` / `ccr_` thinking signature / DB名）。詳細は CLAUDE.md の
対応表。`CCR_ACCOUNT_ENCRYPTION_KEY` だけは既存 `SubAccount` 行の復号鍵なので、
変数名の変更時に**値を変えてはいけない** — `encryptionKey()` はその旨を含む
エラーを投げる。

---

### Phase 2 — Inbound Surface 集約 + ルーティング多面化

**目的**: §3.2 と §3.3-1,2 を潰す。今回のリファクタの中核。

#### 2-1. `InboundSurface` 記述子の導入

`src/api/v1/` を `src/api/inbound/` に整理し、面ごとの知識を1つの記述子へ集約する:

```ts
interface InboundSurface {
  id: 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'
  paths: string[]                       // ルート登録
  auth: 'x-api-key' | 'bearer' | 'google'
  errorShape: (status, message, upstream?) => unknown
  aggregateSse: (res: Response) => Promise<Record<string, unknown>>
  extractModel: (req) => string | undefined   // geminiはパスから取る
  inboundType: 'anthropic' | 'openai' | 'gemini'
  defaultRoutingMode: 'routed' | 'passthrough'
}
```

散っていた `errorShapeForPath` / `pickSseAggregator` / `openaiBearerAuth` のパス列挙 / `inboundType` を、この記述子1つに寄せる。

#### 2-2. Gemini 受け口の有効化

- `POST /v1beta/models/:modelAndAction` を実際にマウント（現状は宣言のみで到達不能）
- 認証: `x-goog-api-key` ヘッダと `?key=` クエリを受理する `googleApiKeyAuth` を追加
- モデル名はパスから来る（bodyに無い）→ `extractModel` で吸収
- エラー形式3種目: `{ error: { code, message, status } }` を `errorShape` に追加
- `aggregateGeminiSseToJson` を追加
- `RequestLog.inboundType` に `'gemini'` を追加（マイグレーション）

#### 2-3. ルーティングの多面化

- `scenario-router.ts` のハードコードされたバイパスを削除し、面の `routingMode` を参照する形に置き換える
- `RouterPreferenceProfile.key` を面キーとして使う（§4.2）
- `/api/router-preferences` に面パラメータを追加
- **既定値は現行踏襲**（messages=routed、他=passthrough）。挙動不変のまま設定可能になる

#### 2-4. transformer選択の廃止

§3.4 の結論。選択肢が実質存在しない設定欄を消す。

- `provider.transformer.use` を廃止し、`apiStyle` + `authMode` からの導出に一本化
- ナビの Transformers 画面と、provider 編集ダイアログの transformer picker / options エディタを削除
- `Provider.transformer` JSONB は残すが、中身は既に `_disabledModels` / `providerEnabled` という
  別用途になっているので、Phase 4 で正式なカラムへ昇格させて JSONB を畳む
- UIには**読み取り専用の Request shape** 表示だけ残す（apiStyle / auth / pipeline / endpoint）。
  「このproviderが何を喋るか」は不調時の診断に効く
- envelope の `transformers[]` と `PLUGINS_DIR` は、読み手が無いので削除。CLAUDE.md の
  該当記述も落とす
- `VENDOR_DEFAULTS.deepseek` の宙に浮いた `use: ['deepseek']` を除去

失うのは「将来カスタム transformer を挿す拡張点」だが、**その拡張点は現在動いていない**ので、
失うのは実装ではなく設定欄だけ。必要になったら `InboundSurface` レジストリと同じ形で
`apiStyle → transformer` の写像に1行足す方が素直。

##### 実施結果 (2026-08-31) — **Done**

導出は `src/shared/transformer-chain.ts` の1枚に集約した。`shared/` に置いたのは、
サーバの `ProviderRegistry` と Providers 画面の Request shape 表示が**同じ関数**を読む
ためで、以前は UI が `derive.ts` に写像を写経していて（`pipelineOf`）、実際に走る chain と
食い違っていた。純粋な文字列写像で import ゼロなのでブラウザバンドルに入れて問題ない。

| apiStyle | api_key | subscription |
|---|---|---|
| `anthropic` | （変換段なし） | `claude-code-oauth` |
| `openai_chat` | `openai` | 未対応 → 登録しない |
| `openai_responses` | `openai-responses` | `openai-responses` → `codex-oauth` |
| `gemini` | `gemini` | 未対応 → 登録しない（Phase 3-2） |

判断が要った点:

- **`anthropic` / api_key を空にした**。`anthropic` を積むと chain 長1が endpoint
  transformer と一致し、**bypass モードに落ちる**。no-op ではなく別経路なので、現行の
  非 bypass 挙動を保つには空が正しい
- **chain が `null`（未対応の subscription 組）と `[]`（変換段が不要）を区別する**。null は
  provider を登録しない。placeholder キーのまま upstream を叩かせないため
- **base URL フォールバックは subscription に限って残した**。`apiStyleForVendor` は名前しか
  見ないので、pre-Rialto config から来た非正規名の自前プロキシが `openai_chat` に落ちて
  auth 段を失う。api_key 側には効かせない（`api.openai.com/v1/...` は普通の chat ベンダ）

副作用として2件のバグが直った。どちらも「設定欄が機能していない証拠」そのものだった:

- **deepseek** は `use: ['deepseek']` という未登録名を指しており、`resolveUseEntry` が
  `undefined` を返して**空 chain**になっていた。OpenAI 側のリクエスト書き換えが効いていない
- **minimax** は base URL が `/v1/text/chatcompletion_v2` で `applyOpenAIOverlay` の
  URL 判定（`api.openai.com` か `/chat/completions` 末尾）に当たらず、同じく chain 無しで
  unified 形をそのまま送っていた

削除したもの: `src/services/openai-overlay.ts`（全体）、`applySubscriptionAuth` の chain 選択、
`ProviderTransformerSchema.use`、`TransformerUseEntrySchema` と registry の `[name, opts]`
解決経路、`VENDOR_DEFAULTS.transformer`（deepseek / google）、`SeedRow.transformer`、
`provider-edits.ts` の transformer picker / options ヘルパ9本（317行 → 30行。Phase 5 で
ダイアログが消えて以来 `setModelDisabled` 以外は全部死んでいた）。

古い build が書き残した `use` は `toProvider` と `buildStoredTransformer` の両方で落とすので、
既存 DB 行を移行する必要はない。テストは `__tests__/shared/transformer-chain.test.ts`（写像）と
`__tests__/llms/provider-registry-chain.test.ts`（解決と skip）。

ドキュメント側も1件直した。README（3言語）の「Built-in transformers」表は **19個**を列挙し
`transformer.use` の設定例まで載せていたが、これは吸収元 `@musistudio/llms` のカタログで、
このリポジトリに実在するのは6個だけだった（`openrouter` / `maxtoken` / `tooluse` /
`vertex-gemini` 等は登録されていない）。実在する6個と導出表に差し替えた。ほかに
`src/shared/preset/schema/post-process.ts`（ファイル全体が孤立、import 元ゼロ）と、
参照コードの無い locale キー `nav.transformers` / `providers.transformers` を削除。

**持ち越し**: 「`Provider.transformer` JSONB を正式カラムへ昇格させて畳む」は
**2026-09-01 に完了**（マイグレーション `20260901081806_promote_provider_enabled`）。

##### 昇格の設計 (2026-09-01 棚卸し)

JSONB が運んでいる3つは**性質が違い、行き先も違う**。ひとまとめに「カラムへ昇格」と書くと
間違える。

| キー | 実体 | 行き先 |
|---|---|---|
| `_disabledModels` | `Model.enabled` の**派生ビュー**（wire 形。反転している点に注意） | **列は既にある。** `Model.enabled` が権威だとスキーマコメントが明記済み。読み手を全部そちらへ向け替えて、このキーを消すだけ |
| `providerEnabled` | provider 単位の有効/無効 | **新規カラム `Provider.enabled Boolean @default(true)`。** `providerEnabled === false` のときだけ false を backfill（`!== false` が現行の判定なので、キー無し = 有効） |
| `subscriptionAuth` | OAuth 資格情報 | **カラムにしない。** `subscription-overlay.ts` が実行時に載せるだけで**DBには一度も書かれない**。列にすると平文の資格情報が永続化される。パイプライン側の provider 型に残す実行時フィールドであって、ドメイン型のフィールドではない |

したがって作業は「JSONB を列にする」ではなく、**永続化される1つを列へ移し、残り2つが
そもそも永続化されていないことを確認する**ことだった。実際 `_disabledModels` は読むたびに
`Model.enabled` から再生成され、書き込み前に落とされていた（＝一度も保存されていない）ので、
列は `Provider.enabled` 1本で足り、JSONB は丸ごと落とせた。

##### 実施結果 (2026-09-01) — **Done**

`Provider.enabled Boolean @default(true)` を追加し、`Provider.transformer` を削除した。

マイグレーションで**順序が本質的**だった。`prisma migrate dev` が生成した SQL は
`DROP COLUMN transformer` と `ADD COLUMN enabled DEFAULT true` を1文にまとめており、
これをそのまま適用すると **operator が無効化していた provider が全部黙って有効に戻る**。
`ADD` → `UPDATE ... WHERE transformer -> 'providerEnabled' = 'false'::jsonb` → `DROP` の
3段に書き直してある。

型が守ってくれなかった点も記録しておく。列を削除して client を再生成したあとも、
`prisma.provider.upsert({ update: { transformer: ... } })` は **`tsc` を素通りした**
（Prisma 7 の入力型が余剰プロパティを弾かない）。存在しない列への書き込みは実行時にしか
落ちないので、スキーマから列を消すときは型検査ではなく**呼び出し箇所の grep** で追うこと。

読み替えた箇所: `compose.ts`（`enabled: p.enabled`、`toWireTransformer` は
`_disabledModels` の射影だけになった）、`apply/providers.ts`（`enabled` を直接 upsert）、
`apply/fields.ts`（`buildStoredTransformer` 削除）、`config/transformer.ts`
（`providerEnabledFromTransformer` 削除）、`enabled-models.ts`、`provider-test-service.ts`、
`subscription-info-service.ts`。ドメイン型の `Provider.transformer` は**残る** —
subscription の資格情報を実行時に載せる器と、UI 向けの `_disabledModels` ビューであって、
DB の列ではないため。

回帰テストは `__tests__/db/config-service.test.ts` に3本追加（有効/無効の往復、
`enabled` を含まない payload が無効化しないこと、無効な provider の model が
`getEnabledModels` から外れること）。

読み替えが要る箇所（実測）— `_disabledModels`: `components/rialto/providers/{derive,actions,connect-actions}.ts`、
`components/rialto/routing/derive.ts`、`lib/providers/provider-edits.ts`、`lib/models/build-rows.ts`。
`providerEnabled`: `services/{subscription-info-service,provider-test-service}.ts`。
実行時オーバーレイ側: `services/subscription-overlay.ts`、`llms/transformers/oauth-base.ts`、
`llms/registry/provider.ts`、`llms/pipeline/{request-chain,response-chain}.ts`。

マイグレーション後は `bun run db:migrate:test` も必ず流す（`rialto_test` は別DB）。

#### 2-5. パリティ・マトリクス

面 × 機能で表を定義し、各セルにテストを割り当てる。

**空白セルの洗い出しがこのフェーズの実質的な成果物**。埋められないセルは「未対応」として明示的にドキュメント化する（黙って落とさない）。

##### 実施結果 (2026-09-01) — **Done**

埋めた表と各セルの根拠は `docs/architecture/inbound-parity.md`。テストは
`__tests__/parity/**`（13ファイル / 103テスト）で、全セルに担保が付いた。

| | messages | chat/completions | responses | gemini |
|---|---|---|---|---|
| ストリーミング (SSE) | 対応 | 対応 | 部分 | 対応 |
| 非ストリーム集約 | 対応 | 対応 | 対応 | 対応 |
| tool use | 対応 | 対応 | 対応 | 部分 |
| system プロンプト | 対応 | 対応 | 対応 | 未対応 |
| 画像入力 | 対応 | 対応 | 対応 | 未対応 |
| thinking / reasoning | 対応 | 部分 | 部分 | 部分 |
| usage 記録 (RequestLog) | 対応 | 対応 | 対応 | 未対応 |
| エラー形式 | 対応 | 対応 | 対応 | 対応 |
| cacheトークン計上 | 対応 | 対応※ | 部分※ | 未対応 |
| failover / 429 | 対応 | 対応 | 対応 | 対応 |

**この表の主目的は達成された** — 空白が埋まり、gemini 列が横並びで欠けていることが見えた。
そしてそれは機能ごとの取りこぼしではなく、**単一のバグに帰着した**。

`GeminiInboundContentObjectSchema` が `text: z.string().default('')` を宣言しているため、
パース後は `content.text` が**常に string** になる。`inboundContentToMessage`
（`src/llms/utils/gemini-request.ts:91`）の `if (typeof content.text === 'string')` が必ず成立し、
その下の `role === 'user'` / `role === 'model'` の `parts` 分岐が**到達不能**になっていた。
結果、Gemini の正規ワイヤ形式 `{ contents: [{ role: 'user', parts: [{ text }] }] }` が
`[{ role: 'user', content: null }]` に潰れる — **本文が消え、`model` ロールが `user` に潰れる**。
（この因果は親側でスキーマと実装の両方を読んで独立に確認した。）

到達条件が重要で、**バイパス経路はこの変換を通らない**。既定の `passthrough` では踏まないが、
**Routing 画面で gemini 面を `routed` にした瞬間に無言で壊れる**。「4面すべてでルーティング設定が
効く」という Phase 2 の完了条件に直接抵触するので、修復を別作業として起票した。

**もう一つ、完了条件に直接刺さる発見があった** — シナリオ分類そのものが Anthropic 語彙に
依存していた。`longContext`（サイズ判定）は messages / chat のみ、`webSearch` / `think` /
effort ベースの `longContext` は **messages のみ**効いていた。つまり他3面を `routed` にしても、
実質 `default` レーンにしか落ちない。`routingMode` の多面化（2-3）とシナリオ分類の多面化は
別の作業だった、というのが結論。

##### 2-6. シナリオ分類の多面化 (2026-09-01) — **Done**

`src/llms/scenario-router/surface-signals.ts` を新設し、**面ごとの語彙差をここ1枚に閉じ込めた**。

```
RouterSignals = { tokenize, thinking, effort, toolNames, webSearch }
READERS: 面id → 抽出関数（未登録の面は Anthropic 版へフォールバック）
```

読み替えたのは3箇所。**分類器だけでは足りない**のがポイントで、`rules.ts` の述語
（`hasTool` / `thinking` / `effort`）も同じ Anthropic 形を直読みしていたため、分類器だけ直すと
Rules 画面が面ごとに割れたままになる。

| 直した場所 | 前 | 後 |
|---|---|---|
| `classifyScenario` | `body.thinking` / `tools[].type` を直読み | `signalsOf(req)` |
| `rules.ts` の述語 | 同上 | `signalsOf(req)` |
| `countRequestTokens` | `body.messages` 固定 | `signals.tokenize` |

**設計判断が2つ。** `toolNames` は**ベンダの語彙のまま**返す — 正規化すると Rules 画面で
operator が「自分のクライアントが実際に送る名前」を書けなくなる。`webSearch` は綴りが全ベンダで
違うので glob ではなく**意味論的な真偽値**として分離した。

写像の実測:

| シグナル | anthropic-messages | openai-chat | openai-responses | gemini-generate |
|---|---|---|---|---|
| 本文 | `messages` | `messages` | **`input`** | **`contents[].parts[]`** |
| system | `system` | ロール `system` のメッセージ | **`instructions`** | **`systemInstruction`** |
| thinking | `thinking.type !== 'disabled'` | `reasoning_effort` | `reasoning.effort` | `generationConfig.thinkingConfig` |
| effort | `output_config.effort` | `reasoning_effort` | `reasoning.effort` | `thinkingLevel` → `thinkingBudget` |
| tool 名 | `tools[].type` | `tools[].function.name` | `tools[].name`（平坦） | `functionDeclarations[].name` |
| web 検索 | `type` が `web_search*` | `web_search_options` / `web_search*` | 同左 | `googleSearch` 系 |

gemini 側は `src/llms/utils/gemini/inbound-request.ts` の `contents[]` walk を**再利用**した。
変換とルーティングで `contents[]` の解釈が割れないことが、独立実装より重要だと判断した。

受け入れテストは `__tests__/parity/routing-lanes.test.ts`（16件）。**各面のクライアントが
実際に送る綴り**で think / webSearch を要求し、レーンに到達すること・シグナルが無ければ
`default` に落ちること・分岐順序（webSearch が think より優先）が面をまたいで一致することを
固定している。テストが Anthropic 形に寄せて書かれていたら何も検証しないことになるので、
そこは意図的に面ごとの綴りにしてある。

**残る非対称（ベンダ側の制約。塞げないので明示する）**:

- **OpenAI 2面では effort→longContext の escalation に到達しない**（think レーンを設定している
  場合）。Anthropic は `thinking` と `output_config.effort` が**独立した2フィールド**なので
  「頑張れ、ただし考えるな」を表現できるが、**OpenAI はノブが1つ**（`reasoning_effort`）しかない。
  `'none'` 以外の effort は必然的に reasoning の opt-in でもあるため、分岐順で先に来る think が
  必ず勝つ。think 未設定なら longContext に落ちることはテストで固定してある
- **`minimal` / `none` は `low` に丸める**。`EffortLevel` に `low` より下の段が無い。`undefined`
  に落とすと「何も言わなかった」扱いになり、`isHeavyRequest` がモデル tier での escalation に
  フォールスルーしてしまう。最安の推論を明示した呼び出し側は**何かを言っている**ので、
  escalation を抑止する `low` が正しい
- **画像パートは計数しない**（4面とも）。テキストを持たないため。Anthropic reader が自分の
  image ブロックを無視しているのと揃えてある
- **Codex CLI の `reasoning` item（`encrypted_content`）は計数しない**。不透明な base64 を
  テキストとして数えると、省略による過小評価よりはるかに大きく過大評価する

その他、面をまたいで見つかった歪み:

- **gemini の usage が RequestLog に1行も残っていなかった（修正済み・2026-09-01）** —
  `UsageBlockSchema` が Gemini の `usageMetadata` を宣言しておらず、`extractUsage` が null を
  返して `captureUsage` が即 return していた。`captureUsage` は**変換前の生上流応答**を読むので、
  これは変換経路だけでなく **バイパス経路＝通常運用でも起きていた**。Activity にもコスト集計にも
  Gemini のトラフィックが一切出ていなかったことになる。マイグレーションは不要で、`RequestLog` の
  列はもともと揃っており埋める値が来ていなかっただけ
- **`src/llms/pipeline/message-capture.ts`（チャットビュー用 Message 表）が Anthropic 形状専用** —
  マトリクス外だが同種の欠落

- ※ **cache トークンの計上を修正した（2026-09-01）。** 表面的にはフィールド名の欠落
  （Chat は `prompt_tokens_details.cached_tokens`、Responses は `input_tokens_details.cached_tokens`
  なのに後者しか宣言していなかった）だが、**足すだけでは別のバグが入る**。Anthropic の
  `input_tokens` は非キャッシュ分だけでキャッシュ分は隣に並ぶのに対し、OpenAI の
  `cached_tokens` は SDK 型定義が "Cached tokens present in the prompt" と明記するとおり
  `prompt_tokens` の**内訳で既に含まれている**。`computeTokenStats` は Anthropic 式に
  無条件加算していたので、**Responses 経路では以前から input が命中分だけ水増しされていた**。
  慣習を判別して合算前に差し引く形に直した。パリティ側のフィクスチャが
  `input_tokens: 20` にキャッシュ 80 という OpenAI からは来ない値で、偶然辻褄が
  合っていたのがこの誤りを隠していた
- **thinking のブロック順が面ごとに割れている** — messages は annotation → text → tool_use → thinking の順に積むが、Anthropic 本家と gemini 側実装はどちらも思考を先頭に置く
- **responses のストリーミングが逐次性を失う**
- **OpenAI の `cache_write_tokens` を読んでいない** — 両面の SDK 型に存在するが未宣言。
  `prompt_tokens` の内訳に含まれるかを確認してからでないと (10) と同じ二重計上を招くので保留

完了条件:
- 面を1つ足す作業が「記述子を1つ足す」だけで済む
- 4面すべてでルーティング設定が効く（面ごとにon/off可能）
- パリティ・マトリクスの全セルに「対応済み / 未対応（理由付き）」のラベルとテストがある

---

### Phase 3 — Gemini 対応

**目的**: Gemini を api_key 枠・サブスク枠の両方で一級市民にする。

#### 3-1. `google`（api_key）の品質向上

既存の `GeminiTransformer` + `src/llms/utils/gemini*` を、Phase 0 で整えたフィクスチャで固める。既存の `__tests__/providers/__fixtures__/google-gemini-*` を拡張。

#### 3-2. `gemini-cli`（subscription）の新設

Claude Code / Codex と**同じ形**に載せる（`OauthBase` → `SubAccount` → quota collector）。

- **OAuth**: Gemini CLI の client_id + PKCE。`~/.gemini/oauth_creds.json` からのインポートにも対応（Claude/Codexと同じく `POST /api/oauth/import-credentials` 経路）
- **エンドポイント**: Code Assist API（`cloudcode-pa.googleapis.com`）。`:generateContent` / `:streamGenerateContent` の前に `:loadCodeAssist` / `:onboardUser` で projectId を解決する必要がある
- **transformer**: `GeminiCliOauthTransformer`（`ClaudeCodeOauthTransformer` / `CodexOauthTransformer` と同じ構造）
- **SubAccount**: `buildGeminiDiscoveredAccount` を追加。plan は `free` / `ai-pro` / `ai-ultra`、`monthlyPriceUsd` を `pricing.ts` に追加
- **ApiStyle**: enum に `gemini_code_assist` を追加（マイグレーション）
- **SUBSCRIPTION_PRESETS** に `gemini-cli` を追加

##### スパイク結果 (2026-09-01) — **descope 決定**

全文は `docs/plan/rialto/gemini-code-assist-spike.md`（一次ソース付き）。要点は2つで、
**判定した未確定リスクは解消し、代わりに想定していなかったほうが壊れた**。

1. **クォータ取得は可能だった。** `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
   が実在し、gemini-cli 本体が使っている。per-model の bucket 配列で `remainingFraction`（0..1）を
   返すので、`SubAccountQuota` の pct 規約（`used = utilization`, `limit = 100`）にそのまま乗る。
   **「429反応型のみに落ちる」という劣化分岐は不要。**
2. **しかし対象ティアが消滅している。** 2026-06-18 をもって Gemini CLI / Code Assist IDE 拡張は
   **individuals（無料）/ Google AI Pro / Google AI Ultra へのリクエスト提供を停止**した
   （公式アナウンス + Google Cloud のクォータ表から当該ティアが消えていることで確認）。
   上の「plan は `free` / `ai-pro` / `ai-ultra`」は**もう存在しない対象を指している**。

残る経路は3つで、実質1つしかない。

| 経路 | 技術 | ToS | 評価 |
|---|---|---|---|
| Code Assist **Standard / Enterprise**（GCPシート） | 稼働中 | 要確認 | 実装可能。ただし個人サブスク枠ではなく B2B シート課金で、`monthlyPriceUsd` の意味が Claude Max と揃わない |
| **Antigravity** の OAuth 流用 | 可能 | **明示的に禁止** | 採用不可 |
| `google` api_key | 可能 | 可 | **Phase 3-1 で実装済み**。無リスク |

2. の主張は **descope 判断の土台になるので独立に裏を取った**（一次ソース2件を直接確認）:
Google Developers Blog の停止アナウンスは逐語一致（"On June 18, 2026, Gemini CLI and Gemini
Code Assist IDE extensions will stop serving requests for Google AI Pro and Ultra, as well as
those using it free of charge using Gemini Code Assist for individuals."）、
`docs.cloud.google.com/gemini/docs/quotas` のクォータ表も **Standard 1,500 req/day と
Enterprise 2,000 req/day のみ**を掲載し、individuals / AI Pro / AI Ultra は不在だった。

**未検証で残っている最大の点**: `retrieveUserQuota` が Standard / Enterprise ティアでも
bucket を返すか（個人ティア専用機能だった可能性を排除できていない）。返らなければ 1. の結論は
覆る。検証には実ライセンスが要る。

**判断: 実施しない（descope）。** スパイク後に実アカウントで検証まで進め、次を確認した。
公式 CLI が個人枠で `not eligible for Gemini Code Assist for individuals` を返すこと
（提供停止が実機で再現した）、Code Assist は未契約だったこと、そして契約しても
ライセンス1枚で **$22.80/月・シート**が発生すること。Rialto から Gemini を叩くだけなら
**AI Studio の api_key（3-1 で実装済み）で足りる**ので、月額シートを買う理由がない。
また Code Assist は組織アカウント前提で `GOOGLE_CLOUD_PROJECT` が必須（公式ドキュメント明記）で、
Claude Code / Codex の「OAuth でログインするだけ」とは体験が別物になる。詳細と、将来
再開する場合に使える調査結果は `gemini-code-assist-spike.md` §0。

なお **`Gemini Cloud Assist` と `Gemini Code Assist` は別製品**である。前者は GCP コンソール向けの
アシスタントで無料枠があるが、`cloudcode-pa` の権限は付かない。Google 自身のエラー文でも
両者が混ざっており、調査中に一度これで誤誘導された。

**副次的に見つかった要修正点**: `SetupScreen.tsx` の `CONNECT_OPTIONS` が初回セットアップ画面で
「Gemini CLI / AI Pro・Ultra」を接続候補として**実際に描画している**。存在しないティアを
新規ユーザーに案内している状態なので、descope の可否と無関係に直す必要がある。
`vendor-labels.ts` の `gemini-cli` エントリ4件は `catalog-service.ts` がカタログを
`SUBSCRIPTION_PRESETS` から生成する都合で到達不能（knip はマップのキーを検出しないので
デッドコードとしても報告されない）。

#### 3-3. 周辺の組み込み

- `model-test-service` / `probes.ts` に gemini_code_assist 用プローブ
- 価格スクレイプ（`scrape-gemini-pricing.ts`）はサブスク枠には無関係なので api_key 側のみ
- Router / catalog / UI のモデル一覧に反映

完了条件:
- Gemini CLI で `RIALTO_BASE_URL` を向けて実際に対話できる
- Gemini のサブスクアカウントが Providers 画面に Claude / Codex と並んで表示される
- クォータ取得可否の結論が本ドキュメントに記録されている

---

### Phase 3.5 — 認証: Cloudflare Access + アクセストークン

**目的**: §3.3-9 を潰す。単一 `APIKEY` を、**面ごとに責任者が違う2層**に置き換える。

#### 3.5-0. 前提となる構成

管理UIは Cloudflare Access（エッジ）で守り、`/v1/*` は Rialto 自身のトークンで守る。

```
Access app A:  rialto.example.com/     Allow (email)     → UI + /api/*
Access app B:  rialto.example.com/v1   Bypass (Everyone) → Rialto の access token
```

**`/v1/*` を Bypass にせざるを得ない理由**: Claude Code / Codex CLI / Gemini CLI はブラウザでは
ないので対話ログインができず、サービストークン（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）
のヘッダも送れない。よってこの経路はエッジを素通りさせ、Rialto のトークンが唯一の門になる。

（クライアントが任意ヘッダを送れる場合は Service Auth ポリシーでエッジ側にも門を置ける。
CI など制御下のクライアントでは検討する価値がある。）

#### 3.5-1. Access JWT の検証（`/api/*`）

- ヘッダ `Cf-Access-Jwt-Assertion` の JWT を検証する
- JWKS: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- `issuer` = チームドメイン、`audience` = そのアプリの AUD タグ（`ACCESS_AUD`）
- 検証済み payload の `email` を管理操作の実行者として記録する
- **ヘッダを信用するだけでは不可**。オリジンに直接到達できると偽装できるため、
  cloudflared 経由でオリジンを非公開にするか、検証を必ず通す

**ログイン画面は作らない。** 認証主体が Cloudflare に移るので、アプリ側に持つと認証系が
二重になり、弱いほうが残る。`Login.tsx` は Phase 5 で削除する。

#### 3.5-2. アクセストークン（`/v1/*`）

```
AccessToken
  id, name, tokenHash (sha256, unique), prefix (表示用の先頭8文字)
  endpoint     面に固定する場合のみ（null = 全面）
  profileKey   RouterPreferenceProfile.key（null = 既定）
  lastUsedAt, requestCount, expiresAt?, revokedAt?
```

- **スコープは廃止**。全トークンが `/v1/*` 専用（`admin` は Cloudflare Access が代替する）
- 平文は保存しない。発行時に1度だけ表示し、以後は復旧不能（再発行のみ）
- ホットパスなので `lru-cache`（既存依存）でハッシュ→行をキャッシュ。失効時に無効化。
  現行の fail-closed 挙動は維持する
- `RequestLog` に `accessTokenId` を追加 → Activity で「どのクライアントが焼いたか」が出せる

#### 3.5-3. 認証モード

| モード | `/api/*` | `/v1/*` | 用途 |
|---|---|---|---|
| `cloudflare_access` | Access JWT（+ bootstrap token フォールバック） | AccessToken | 公開デプロイ |
| `token` | bootstrap token | AccessToken | ローカル / loopback |

**envelope の bootstrap token は残す**。Access が前段に無いローカル実行と、Postgres が落ちて
UIごと締め出される事態の両方を救う。env 名は `RIALTO_TOKEN`（旧 `APIKEY` も読む、Phase 1）。

> **2026-09-10 追記**: bootstrap token（envelope の `APIKEY`）はその後**削除した**。`/api/*` を通れるのは
> ホスト上からのリクエスト（ローカル免除）と検証済みの Access assertion だけで、共有の管理シークレットは無い。
> 理由は、`config.json`・バックアップ・シェル履歴から読めば誰でも Access を迂回できるマスターキーだったこと、
> そして上で救うとした 2 つの事態（Access の無いローカル実行 / Postgres 停止での締め出し）は、どちらも
> ローカル免除 — 必要ならホストへ SSH してポートを転送する — で秘密なしに入り直せること。

得られるもの: エッジでの ID 認証、個別失効、帰属、そして**クライアント単位のルーティング**
（CIのトークンだけ `cost-first` に固定する、など）。

モック: `mocks/settings-access.html` / `mocks/system-states.html`（Access 拒否時）

### Phase 4 — Zod スキーマ層分け

**目的**: §3.3-3 を潰す。29ファイルのフラット層を役割で分ける。

```
src/schemas/
  primitives/   RecordSchema・共通enum・共通スカラ
  wire/         外部ワイヤ形式（inbound surface と1:1）
    anthropic/  openai/  gemini/
  domain/       Provider / Model / Router / SubAccount … DB由来のドメイン型
  api/          /api/* の request/response DTO（domain から導出、.openapi() はここだけ）
  forms/        UIフォーム（api から導出）
```

規約:
- 型の唯一の源は `z.infer`。手書きの重複 interface を作らない
- `.openapi()` は `api/` 層でだけ付ける
- barrel は**層単位**（`@/schemas/wire` など）。全体 barrel `@/schemas` は廃止する
- Zod v4 の機能を使う: `z.iso.datetime()` / `z.strictObject` vs `z.looseObject` の意図的な使い分け / registry API

作業:
- まず重複の実測。`Provider` 形が `config.dto` / `provider.dto` / `llm-pipeline.dto` / `preset.dto` に散っている疑いがあるので、計測してから1本化する（推測で統合しない）

#### 実測結果（2026-08-31）

**Provider 形の重複は無かった。** 3つは重複ではなく、段階的に狭い射影である:

| 定義 | フィールド数 | 何を表しているか |
|---|---:|---|
| `provider.dto.ts` `ProviderSchema` | 16 | ドメイン／API の完全形（auth_mode・テスト状態・サブアカウント含む） |
| `llm-pipeline.dto.ts` `RuntimeProviderSchema` | 6 | リクエスト時にパイプラインが必要とする分だけ |
| `preset.dto.ts` `PresetProviderSchema` | 5 | 共有可能なプリセットに載せてよい分だけ（秘密と環境依存を除く） |

`config.dto.ts` に `ProviderSchema` の定義は無い（`provider.dto` から import している）。
**1本化してはいけない。** preset に auth_mode やサブアカウントが載れば共有時に環境が漏れ、
pipeline が16フィールドを要求すれば実行時に不要な結合が生まれる。層分けの目的からして、
この3つは別の層に属していて正しい。

**実際の問題は全体 barrel のほうだった。** `@/schemas` を import しているファイルは **97**
（import 箇所 118）。うち **14 がUI側**（`src/components/**` と `src/lib/**`）で、
`export *` × 29 により **oauth / pipeline / prisma由来のサーバ専用スキーマがブラウザバンドルに
入っている**。Phase 4 の主目的はここで、Provider の統合ではない。
- 移行は旧 barrel を re-export shim にして段階的に。最後に shim を削除

完了条件:
- `@/schemas` の全体 barrel が消えている
- UIバンドルにサーバ専用スキーマが入っていない（bundle analyzer で確認）
- スキーマ総行数が削減（数値目標は重複の実測後に設定する）

---

### Phase 5 — UI 刷新（モック駆動）

**目的**: 15以上に散った画面を5つに集約し、視覚設計を刷新する。**基盤は維持**（react-router-dom v7 / shadcn / Tailwind v4）。

#### 5-1. 新しい情報設計

| 新画面 | 統合元 |
|---|---|
| **Overview** | 新規。稼働状態・4面のトラフィック・クォータ・直近セッション・コストの1枚要約 |
| **Routing** | RouterPreferences + RoutingLibrary + RoutingLiveEditor + RoutingPresetEditor + TierEditor + RouterUtilization |
| **Providers** | Providers + Subscriptions + ModelsDashboard + Transformers + catalog |
| **Activity** | Sessions + SessionDetail + Usage + ApiCost + LogViewer |
| **Settings** | SettingsPage + Presets + Personas + StatusLine + Debug。Access セクションに Cloudflare Access の状態とトークン管理（Phase 3.5）が入る |

`Login.tsx` は移行先を持たない — **削除**する（§Phase 3.5-1）。

Routing画面には **Phase 2 で入る「面セレクタ」** が乗る。ここが「messages専用に見える」問題の解消点。

#### 5-2. モック駆動の進め方

1. `mocks/**/*.html` に静的モックを作る（プロジェクトと**同じTailwind・同じデザイントークン**でビルド） — **完了**
2. **人間がモックをレビューして承認する** ← ここで一旦停止（**現在ここ**）
3. 承認されたモックを実装ターゲットとしてReactコンポーネントを実装
4. `ui-mock-diff` スキルで、モックとReact実装をRetina解像度（`deviceScaleFactor: 2`）で撮影し、ピクセル差分を取って収束させる

作成済みの成果物:

レビューの入口: `bun run mocks:serve` → http://localhost:16176/mocks/index.html
（21ビュー。既存の全ルートとダイアログの行き先が index に「統合元」として明記してある）
（`file://` で直接開いてもよい。両者のレンダリングがピクセル単位で同一であることは `mocks:diff` で確認済み）

| パス | 内容 |
|---|---|
| `mocks/index.html` | レビュー用の入口 |
| `mocks/*.html` | **21ビュー**（トップレベルは5画面）。既存22ルート + ダイアログ群を全部カバー。内訳は `mocks/README.md` |
| `mocks/_shared/mock.css` | Tailwindエントリ。`src/index.css` のトークンを逐語コピー |
| `mocks/mocks.json` | 画面レジストリ（モック ↔ Reactルート） |
| `.claude/skills/ui-mock-diff/SKILL.md` | スクショ差分ワークフローのスキル |
| `scripts/build-mock-css.ts` | `bun run mocks:css` |
| `scripts/serve-mocks.ts` | `bun run mocks:serve`（:16176、配信範囲は allowlist 制） |

モックが実装ターゲットとして成立する根拠: `mocks:css` はプロジェクト本体と同じ Tailwind
（`@tailwindcss/node`）でコンパイルし、`src/index.css` の `:root` / `.dark` ブロックが
ずれていたら**ビルドを失敗させる**。フォントとアイコンも `node_modules` から同じ実体を読む。
したがってスクショ差分に出るのはツールチェーン差ではなくデザイン差である。

差分の読み方（`ui-mock-diff` スキル）: 全体一致率は背景の白が支配的なため過小に出る。
**判断材料は `report.json` の `regions`**（差分密度の高い順に並んだ64デバイスpxセル）。

#### 5-3. 遵守すべきUI規約

- `src/components/ui/*.tsx` は**編集禁止**。shadcn CLI (`bunx shadcn@latest add <c> --overwrite`) 経由のみ
- shadcn の `Card` は使わない。`border-l` アクセント + `hover:bg-muted/50` のフラットパターンで統一
- 表で複合指標を1セルに詰めない（`W–L–D` ではなく `W` / `L` / `D` の独立列）。数値は右寄せ mono
- 金額表示は有効数字3桁。既存の `fmtCost` を import する（新規formatterを作らない）
- i18n 3言語（en / ja / zh）のキーを画面統合にあわせて再編する

完了条件:
- 承認済みモックとReact実装の差分が閾値以下（初期目標: 主要ビューポートで mismatch < 2%）
- 旧コンポーネントが削除されている（残骸を残さない）
- 3言語すべてでキー欠落ゼロ

---

### Phase 6 — 仕上げ・v3.0.0

- `knip` クリーン
- `CLAUDE.md` / `README.md`(×3言語) / `docs/**` の全面更新
- Dockerイメージ移行のアナウンス（旧タグに最終ビルド + deprecation notice）
- マイグレーションガイド（旧HOME_DIRからの移行 / 旧Dockerイメージからの移行 / `<CCR-SUBAGENT-MODEL>` タグの新名）
- `v3.0.0` リリース

#### 6-1. デッドコード掃除の実施結果 (2026-09-01)

未使用ファイル 5 → 3、未使用エクスポート 70 → 58。削除したもの:

| 対象 | 行数 | なぜ死んでいたか |
|---|---:|---|
| `src/shared/preset/**`（9ファイル） | 461 | §Presets が「inert」と書いていたもの。本番からの import はゼロで、`__tests__/preset/schema.test.ts` 1本だけが生かしていた |
| `src/components/ErrorPage.tsx` | 131 | `routes.tsx` の `errorElement` が `RouteError` に置き換わった際に取り残された |
| `src/components/ui-ext/input.tsx`（ディレクトリごと） | 26 | 参照ゼロ。`ui-ext` は他に何も無かった |

`src/shared/preset/schema/conditions.ts` は **`src/lib/presets/form-logic.ts` の死んだ双子**だった。
生きている側は `RequiredInputs.tsx` が `shouldShowField` / `getOptions` として実際に描画に使っている。
テストが双子の**死んでいるほう**に向いていたので、カバレッジを生きているほうへ移設した
（`__tests__/lib/preset-form-logic.test.ts`）。`__tests__/preset/schema.test.ts` は、
`schemas/api/config.ts` と `schemas/domain/config.ts` が実際に読む `JsonValueSchema` /
`JsonObjectSchema` だけを検証する内容に縮小した。パスは変えていないので
`bun run test` のスクリプトはそのままで正しい。

削除にあたって `src/shared/index.ts` の `export * from './preset/*'` 2行も落とした。
この barrel の利用者が必要としているのは `./data` と `./db/types` だけで、
`export *` が消えたコードを引きずっていた — §3.3-3 で `@/schemas` について指摘したのと同じ形の問題が
`@/shared` にも小さく残っていたことになる。

**保留していたものの決着 (2026-09-01)**:

- **`src/schemas/forms/**` は層ごと削除した。** `SettingsFormSchema` に読み手が無いだけでなく、
  `react-hook-form` 自体が **shadcn が vendor した `ui/form.tsx` からしか import されておらず、
  その `ui/form.tsx` を import するものがゼロ**だった。つまり「あるべき統合」を先取りした層と、
  その統合先の部品が、両方とも未接続のまま残っていた。連鎖ごと落として
  `react-hook-form` と `@radix-ui/react-slot`（`form.tsx` が名前で直 import していた唯一の
  利用者。他の shadcn は `radix-ui` アンブレラ経由）も依存から外した。
  Phase 4 が宣言した層は **primitives / wire / domain / api の4層**になった。
  必要になれば `bunx shadcn@latest add form` で1コマンドで戻る
- **`src/schemas/primitives/index.ts` も削除した。** 「barrel は層単位」という規約に反すると
  一度は判断したが、実測すると `wire` / `domain` / `api` の barrel は 5 / 34 / 1 ファイルから
  使われていて、`primitives` だけが利用ゼロだった。規約を満たすために置いてある空の器であって、
  規約が要求している「層をまとめて import する経路」の実需が無い。1行で戻せる
- **`src/schemas/domain/preset.ts`** — 生きているのは `JsonValueSchema` /
  `JsonPrimitiveSchema` / `JsonObjectSchema` だけ、という状況は変わっていない。JSON スカラを
  `primitives/` へ移してこのファイルを畳むかは、マニフェスト形式を将来の外部契約として
  残すかの判断が先（**未決**）
- `src/lib/presets/form-logic.ts` の `validateField` — **削除済み**（2026-09-01）。必須チェックは
  `src/lib/rialto/settings-content/presets.ts` の `missingInputIds` に移設済み（テストあり）で、
  `validateField` には呼び出し元が無かった。放置できなかったのは、**この死んだ関数が
  `presets.form.*` 5キーの唯一の参照元**だったため — キー・パリティ検査は間接参照と
  死んだ参照を区別できないので、関数を残したままキーだけ消すと検査が落ち、両方残すと
  死にキーが永久に居座る。関数とキーを同時に落とすのが唯一の整合する直し方だった
  （`src/utils/statusline.ts` の `formatValidationError` と
  `statusline.validation.unknown_error` がまったく同じ形で、同日に同じ処理をしている）。

  **移設先に無い検証を明示的に記録しておく**: `missingInputIds` は空かどうかしか見ないので、
  preset マニフェストの必須入力に書かれた `min` / `max` / `validator` は**受理されて無視される**。
  これは削除で生じた欠落ではなく、実装がすでに走っていなかったものを可視化しただけである。
  塞ぐならフォーム側にエラー表示を足す作業になり、掃除ではなく機能追加

---

## 6. リスクと緩和

| リスク | 影響 | 緩和 |
|---|---|---|
| HOME_DIR移行の失敗で設定喪失 | 致命 | renameではなく**コピー**。旧ディレクトリを残す。冪等。統合テストを書く |
| GHCRイメージパス変更でpull断 | 大 | 旧パスに最終タグ + deprecation notice。READMEに移行手順 |
| Code Assist APIが非公開で仕様変更 | 中 | Phase 3 冒頭でスパイク。クォータ取得不可なら429反応型に限定して明示 |
| リネームと機能変更の同時実行でレビュー不能 | 中 | Phase 1 を**機械的置換のみの単独PR**に隔離 |
| ルーティング多面化で既存messages挙動が変わる | 大 | 既定値を現行踏襲に固定。既存フィクスチャで回帰を押さえる |
| UI全面刷新の途中で使えない期間が出る | 中 | モック承認 → 画面単位で差し替え。旧画面は差し替え完了まで残す |
| `<CCR-SUBAGENT-MODEL>` の改名で外部プロンプトが壊れる | 中 | 旧タグを当面受理。deprecation warn |
| 大量PRでbackmergeが詰まる | 小 | 既存の backmerge ワークフローに従う。Phase単位でdevelopへ着地 |

---

## 7. 検証計画

- **単体**: `bun test __tests__/lib __tests__/db __tests__/preset`
- **プロバイダ契約**: `bun test __tests__/providers`（フィクスチャ再生）
- **inboundパリティ**: §2-4 のマトリクス全セル
- **移行**: 旧HOME_DIR環境からの起動
- **UI**: `ui-mock-diff` スキルによるスクリーンショット差分（light / dark 両方）
- **CI**: `Build` / `Type Check` / `Test` の3ゲートを維持

Prismaマイグレーション後は `bun run db:migrate:test`（`rialto_test`）も必ず流す。

---

## 8. リリース / ブランチ運用

- ベースは `develop`。Phase単位で feature ブランチ → PR → develop
- 本番反映は `develop → master`（devflow の `release` スキル）
- commitlint: scope に `ui` / `format` は不可（`style` は可）。body は200字/行
- バージョンbumpは feature PR 内で手動。CIの `check-version.ts` が唯一の検査

---

## 9. トラッキング

各Phaseに `Done / In Progress / Blocked` を追記して運用する。

| Phase | 状態 | 備考 |
|---|---|---|
| UIモック先行作成 | **Done → 承認済み** | 21ビュー × light/dark（42枚）。`bun run mocks:serve` で確認 |
| `ui-mock-diff` スキル | **Done** | `bun run mocks:{css,shoot,diff}` |
| 0 土台整備 | **Done** | envelope.test.ts のフルスイート限定フレークは解消。原因は import順ではなく `readConfigFile` が `process.env` を上書き合成すること — テスト間で漏れた `API_TIMEOUT_MS` が結果を変えていた。各テストで `ENVELOPE_ENV_KEYS` を消して修正。フルスイート 1121 pass / 0 fail |
| 1 Rialtoリネーム | **Done** | HOME_DIR移行（コピー→検証→旧削除）、旧環境変数の受理を全廃、DB名 `rialto` / `rialto_test`、`ccr_` thinking signature の受理を廃止。既存volumeは `bun run scripts/rename-dev-database.ts`。唯一残した後方互換は `<CCR-SUBAGENT-MODEL>` タグ（外部契約で、外すと**無言で**main-agent chainに落ちるため） |
| 2 Inbound集約+多面ルーティング | **Done** | 2-1〜2-4 完了（記述子への集約、chain は `src/shared/transformer-chain.ts` が apiStyle+authMode から導出）。**2-5 完了** — 全40セルにラベルとテストが付いた（`docs/architecture/inbound-parity.md`、`__tests__/parity/**`）。表が暴いた欠落のうち **gemini の usage 記録**と **cache トークンの二重計上**は修正済み。gemini 面の `contents[]` 変換バグ（`parts` 分岐が到達不能で本文が消える）も修正済み — あわせて `systemInstruction` / 画像 / functionCall / `generationConfig` / `toolConfig` に対応し、gemini 列は10行中8行が「対応」になった。****2-6 完了** — シナリオ分類も多面化した（`surface-signals.ts` に面ごとの語彙を集約、分類器・ルール述語・トークン計上の3箇所を付け替え）。`__tests__/parity/routing-lanes.test.ts` が4面すべてから think / webSearch レーンに到達することを固定。**Phase 2 の完了条件を満たした** |
| 3 Gemini | **Done** | 3-1(inbound有効化) 完了 — `/v1beta/models/:modelAndAction` をマウント、`x-goog-api-key`/`?key=` 認証、google エラー封筒、SSE集約、`inboundType='gemini'`、双方向のワイヤ変換。加えて `contents[]` 変換の破綻を修正し、`systemInstruction` / 画像 / functionCall / `generationConfig` / `toolConfig` に対応。**3-2 は descope** — 対象ティアが 2026-06-18 に提供停止され、実機でも `not eligible for ... for individuals` を確認。Code Assist は未契約で、契約しても $22.80/月・シート。api_key 経路で足りるため実施しない（`gemini-code-assist-spike.md` §0）。到達不能な `gemini-cli` の UI 残骸は削除済み |
| 3.5 認証 | **Done** | 管理UIは Cloudflare Access JWT + ローカル免除、`/v1/*` は発行済みアクセストークンのみ。`AccessToken` テーブルと `src/services/access-token-service.ts` は稼働。bootstrap token は廃止済み（2026-09-10 追記: 実際には envelope の `APIKEY` が `/api/*` の緊急脱出キーとして残っていたため、これも削除した。Access を迂回するマスターキーであり、締め出し時はホストへの SSH ポート転送とローカル免除で入り直せるため）。`/login`・`Login.tsx`・`PublicRoute.tsx` は削除済み（`ProtectedRoute` は資格情報ではなく状態を振り分ける役になった） |
| 4 Zodスキーマ | **Done** | primitives / wire / domain / api / forms の5層に分割し、グローバルbarrelを削除。着手前の計測で、計画が前提にしていた重複は存在しないことが判明（§Phase 4 に記録） |
| 5 UI刷新 | **In Progress** | 21ビュー中20をルーティング済み。モック差分の中央値 3.55%（40ペア中28が5%未満）。旧コンポーネント98ファイル削除済み。**i18n 再編完了** — en/ja/zh 各805キー完全一致、死にキー0、`__tests__/lib/locale-parity.test.ts` がキー集合・補間変数・`<Trans>` タグ・en コピペの4観点を検査。`/login` 削除も完了。**残1件: activity-session** — 実装とルート登録は済んでいるが、モック差分の撮影がセッション実データ待ち（`bun run db:seed:demo` で作れる可能性がある） |
| 6 仕上げ・v3.0.0 | **In Progress** | デッドコード掃除（§6-1）と**ドキュメント全面整合**を実施。`CLAUDE.md` / README 3言語 / `docs/architecture/**` / `docs/guides/**` の記述を実装と突き合わせ、陳腐化を修正。`docs/guides/migration-v3.md` を新規作成。残: Dockerイメージ移行のアナウンス、`knip` クリーンの詰め、v3.0.0 リリース |
