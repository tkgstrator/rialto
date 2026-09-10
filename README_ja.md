[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> LLM トラフィックのルーティングゲートウェイ。4 つのワイヤ形式を受け口で受け取り、設定したベンダーへ振り分けます — クライアント側の設定を変えることなく。

## ✨ 機能

- **4 つの受け口（inbound surface）** — Anthropic Messages（`/v1/messages`）、OpenAI Chat Completions、OpenAI Responses、Gemini `generateContent`。受け口に必要な知識は記述子 1 つに集約されているので、4 面すべてが同じ認証・エラー封筒・ストリーミング・リクエスト履歴を得ます。
- **チェーンルーティング** — シナリオ（`default`、`think`（プランモード）、`longContext`、`webSearch`、`image`）× レーン（`agent` / `subagent`）ごとに、順序付きの `provider,model` チェーンを 1 本持ちます。セレクタはそれを辿り、枯渇した振り先や無効化された振り先を飛ばし、残りのチェーンがそのままフォールバックリストになります。
- **パススルー** — あるいは呼び出し側に選ばせる：passthrough モードの受け口（または 1 本のアクセストークン）では、呼び出し側の `body.model` がそのまま上流へ送られます。
- **アカウントローテーション付きフェイルオーバー** — 429 を受けたらまずピアのサブスクリプションアカウントへ回し、それでも駄目ならチェーンの残りを進みます。チェーンの順序は書かれたとおりに守られ、サブスクリプションの primary から api_key のエントリへ落ちることも含まれます。
- **ペルソナ** — Claude Code 本体に触らずに、`/v1/messages` のリクエストへ毎回名前付きのシステムプロンプトを追記。ライブラリの管理もアクティブなペルソナの選択も Settings → Personas で行います。
- **マルチプロバイダー対応** — API キー型プロバイダー（Anthropic、OpenAI、DeepSeek、Gemini、Groq、OpenRouter など）やサブスクリプション型プロバイダー（Claude Code OAuth、OpenAI Codex）に接続。
- **サブスクリプション監視** — レート制限ウィンドウを追跡し、実際の API コストとサブスクリプション料金を比較。
- **使用量・コストダッシュボード** — プロバイダー別・モデル別のコスト内訳と日別コストグラフ。
- **リクエスト履歴** — 過去のセッションをリクエスト単位の統計・アーカイブ済み会話とともに閲覧。
- **発行型アクセストークン** — 個別に失効でき、リクエスト単位で帰属が取れ、1 つの受け口と 1 つのルーティングプロファイルにスコープできます。
- **Web 管理 UI** — ブラウザで完結する設定管理。手動 JSON 編集不要。
- **トランスフォーマーパイプライン** — チェーンはプロバイダーの API スタイルと認証モードから導出されるので、UI が見せているものと実際に走るものが食い違いません。
- **ステータスライン** — Claude Code のステータスバーに Rialto のリアルタイム状態を表示。
- **Docker ファーストデプロイ** — PostgreSQL と Redis を含む `docker compose up -d` 一発起動。

## 🖥️ Web UI

Web UI（デフォルトでポート **3456** で提供）でゲートウェイのあらゆる設定を管理できます。画面は 5 つで構成されています：

| 画面 | ルート | 目的 |
|------|--------|------|
| **Overview** | `/overview` | トラフィック・支出・サブスクリプションウィンドウの健全性を一望 |
| **Routing** | `/routing` | シナリオ × レーンごとのチェーン、受け口ごとのルーティングモードとプロファイル、プロファイルの制約（`longContext` 閾値を含む）|
| **Providers** | `/providers` | API キー型・サブスクリプション型プロバイダーの追加・編集・削除。プロバイダーごとのモデル・価格・コンテキストウィンドウ・接続テスト、および導出された Request shape の読み取り専用表示 |
| **Activity** | `/activity` | セッション、リクエスト単位のログ（`/activity/requests`）、サーバーログ（`/activity/logs`）|
| **Settings** | `/settings` | Server、**Access**（`/v1/*` 用トークンの発行）、Logging、Personas、Status line、Advanced |

初回起動は `/setup` に着地します。

> スクリーンショットは現行 UI 向けに撮り直し中です。`docs/images/` にあるものは廃止済みの旧 UI を写しているため、誤った製品像を残すよりはと判断してこのページからは外しています。

## 🚀 Docker クイックスタート（推奨）

[Docker](https://docs.docker.com/get-docker/) と [Docker Compose](https://docs.docker.com/compose/install/) をインストール後：

**ステップ 1 — 作業ディレクトリを作成：**

```shell
mkdir -p ~/rialto ~/.rialto
cd ~/rialto
```

設定ファイルは初回起動時に自動生成されます。自分で書く必要があるのは、緊急脱出用の管理キーを置きたい場合だけです：

```shell
cat > ~/.rialto/config.json << 'EOF'
{
  "APIKEY": "your-secret-key"
}
EOF
```

> **`APIKEY` は任意であり、自動生成されなくなりました。** Rialto が動いているマシン上のブラウザは管理ゲートを免除されますし、リモートからの管理アクセスは Cloudflare Access を通す設計です。Access が落ちたときの復旧経路が欲しいときにだけ、意図的に設定してください。効くのは `/api/*` だけです。
>
> **`/v1/*` の認証には決して使えません。** クライアントは **Settings → Access** で発行する*アクセストークン*で接続します。個別に失効でき、リクエスト単位で帰属が取れ、受け口とルーティングプロファイルにスコープできます。トークンを 1 本も発行していないインストールはプロキシを通せません。

**ステップ 2 — `compose.yaml` をダウンロード：**

```shell
curl -fsSL https://raw.githubusercontent.com/tkgstrator/rialto/master/compose.yaml -o compose.yaml
```

**ステップ 3 — （任意）プロバイダー認証情報を `.env` に記述：**

```shell
cat > .env << 'EOF'
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
EOF
```

**ステップ 4 — サービスを起動：**

```shell
docker compose up -d
```

サーバーが `http://127.0.0.1:3456` で起動します。ブラウザで開き、**Providers** ページと **Routing** ページで設定を完了します。続けて **Settings → Access** でアクセストークンを発行してください — クライアントが認証に使うのはこちらです。

**ステップ 5 — Claude Code からゲートウェイに接続：**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

シェル設定ファイルに永続的に追記する場合：

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**ステップ 6 — 使う受け口のルーティングを有効化：**

すべての受け口は `passthrough` モードで出荷され、呼び出し側の `body.model` がそのまま使われます。振り先が揃ったら、**Routing** ページで `/v1/messages`（あるいは実際に叩く受け口）を `routed` に切り替えてください。後述の [受け口](#-受け口inbound-surface) を参照。

**ログを確認：**

```shell
docker compose logs -f
```

**`config.json` を手で書き換えた後の再起動：**

```shell
docker compose restart
```

UI 経由で変更したエンベロープ値は即時反映されます（保存の一部としてプロセス環境変数へ反映されるため）。`rialto` CLI は存在しません。

## 🔌 プロバイダーの接続

### API キー型プロバイダー

**Providers** ページで任意の API キー型プロバイダー（Anthropic、OpenAI、DeepSeek、Gemini など）を選択し、API キーを入力して保存します。`$VAR` 形式の環境変数補間に対応しているため、シークレットをファイルに直書きせず管理できます。

### サブスクリプション型プロバイダー（Claude Code・Codex）

Rialto はサブスクリプション型プロバイダーを API キーなしでルーティングに利用できます。

**Claude Code** — **Providers** ページ → **Subscription** タブ → **Connect** から OAuth フローを完了してください。Rialto が認証情報を保存・自動更新します。

**Codex（OpenAI）** — 現在、ブラウザ経由のログインは未対応です。認証はファイルアップロードによる認証情報の登録のみサポートしています。

> **利用規約に関する注意：** Claude Code のサブスクリプションを Claude Code 以外のアプリケーションからのリクエストに使用することは、[Anthropic の利用ポリシー](https://www.anthropic.com/legal/aup) に違反する可能性があります。この機能の使用は自己責任で判断してください。

## 🚪 受け口（inbound surface）

Rialto は Claude Code 専用プロキシではありません。受け口で 4 つのワイヤ形式を受け取り、それぞれ `src/llms/inbound/surfaces.ts` の記述子 1 つで記述されています：

| 受け口 | パス | 想定クライアント | 認証情報 | エラー封筒 |
|---|---|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | Claude Code | `x-api-key` または `Authorization: Bearer` | `{type:'error', error:{type,message}}` |
| `openai-chat` | `POST /v1/chat/completions` | OpenAI SDK、Cline、OpenWebUI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `openai-responses` | `POST /v1/responses` | Codex CLI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `gemini-generate` | `POST /v1beta/models/<model>:<action>` | Gemini CLI | `x-goog-api-key` または `?key=` | `{error:{code,message,status}}` |

`GET /v1/models` は完了リクエストの面ではなくカタログ読み出しなので、4 面には含まれません。ただし呼び手が OpenAI SDK である以上、認証規約とエラー封筒だけはそちらに合わせて返します。

どの受け口に来たリクエストでも、認証情報は**発行済みアクセストークン**でなければなりません。エンベロープの `APIKEY` が受理されるのは `/api/*` だけです。

### ルーティングモード

各受け口は保存済みのモードを 1 つ持ちます：

| モード | 挙動 |
|---|---|
| `passthrough` | モデルは呼び出し側が選ぶ。シナリオ分類・チェーン・先回りのフェイルオーバーをすべてスキップ。 |
| `routed` | チェーンを走らせる：シナリオ分類 → チェーン走査 → フェイルオーバー。 |

**すべての受け口は `passthrough` で始まります。** 未設定のインストールでルーティングを走らせても意味がない（チェーンが無ければセレクタは呼び出し側のモデルへ素通りする）ので、ルーティングは振り先が揃ってから受け口ごとに有効化するものとしてあります。受け口ごとに専用のルーティングプロファイルを紐づけることもでき、たとえば CI クライアントが叩く受け口だけ cost-first のチェーンに固定する、といった運用ができます。各モードが `body.model` をどう扱うかは [チェーンとパススルー](#チェーンとパススルー) を参照。

## ⚙️ 設定

### ディスクエンベロープ（`~/.rialto/config.json`）

起動時のスカラー値とディスク常駐オブジェクトを格納します。環境変数補間（`$VAR` / `${VAR}`）と JSON5 コメントをサポート。直近 3 世代のバックアップを自動保持。スキーマが知らないキーも破棄されず保持されます。

| キー | 説明 |
|------|------|
| `APIKEY` | `/api/*` 用の任意の緊急脱出シークレット。`x-api-key` または `Authorization: Bearer` で送信。`/v1/*` では決して受理されません。自動生成もされません |
| `HOST` | リスニングアドレス（デフォルト：`127.0.0.1`）|
| `PORT` | リスニングポート（デフォルト：`3456`）|
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access のチームドメイン。`ACCESS_AUD` と併せて `/api/*` の assertion を検証します |
| `ACCESS_AUD` | Access アプリケーションの AUD タグ。**両方揃わないと有効になりません** |
| `LOG` | `true` でログファイルを有効化 |
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `PROXY_URL` | アップストリーム API リクエスト用 HTTP プロキシ |
| `API_TIMEOUT_MS` | アップストリーム API コールタイムアウト（ms）。Bun のリクエスト単位アイドルタイムアウト 1〜255 秒にもクランプされます |
| `CLAUDE_PATH` | `claude` 実行ファイルへのパス |
| `NON_INTERACTIVE_MODE` | Docker / CI 環境で `true` を設定（stdin ハング防止）|
| `CAPTURE_REQUESTS` | リクエストごとに `RequestLog` 行を記録（デフォルト `true`）|
| `CAPTURE_MESSAGES` | 会話のトランスクリプトをアーカイブ（デフォルト `true`）|
| `REDACT_TOOL_ARGUMENTS` | ツール呼び出しの引数をアーカイブから除去（デフォルト `false` — 有効化すると後から復元できない情報が失われるため）|
| `ROUTING_SCHEDULER_INTERVAL_MS` | スケジューラの tick 間隔、60 000〜3 600 000（デフォルト `300000`）|
| `Personas` | ペルソナライブラリ（配列）|
| `ActivePersona` | アクティブなペルソナの uuid id。`null` / 欠落 / 空文字は「無し」。`/api/config` のワイヤ上でもトップレベルキーです |
| `StatusLine` | ステータスライン設定オブジェクト |

旧ビルドが、もう存在しないルーティング機構のために書いたキー — `Router`、`CUSTOM_ROUTER_PATH`、`LiveRoutingName`、`CROSS_PROVIDER_FALLBACK`、`ROUTER_MODE` — は無視されます。`POST /api/config` は警告を出してこれらを捨て、次の保存でファイルからも消えます。

### プロバイダー・モデル・チェーン（データベース）

プロバイダー・モデル・選好チェーン・受け口ごとのルーティングモードは PostgreSQL に置かれ、Web UI（`POST /api/config`、`PUT /api/router-preferences`、`POST /api/inbound-surfaces`）から管理します。`config.json` の**中にある** `Providers` キーは、保存のたびにデータベースから書き戻される一方向のミラーです。手で書き換えても効果はなく、次の書き込みで上書きされます。ルーティングに関するものはもうディスクへミラーされません。

### チェーンとパススルー

Rialto が `body.model` に対してすることは、この 2 つだけです。

**チェーン**（`routed`）。リクエストをシナリオとレーンに分類し、セレクタがそのレーンの順序付き `provider,model` チェーンを辿ります。チェーンの出どころはリクエストが解決するプロファイル — アクセストークンがプロファイルを指定していればそれ、無ければ受け口のプロファイル、それも無ければ `live` — です。有効で、枯渇しておらず、リクエストを収容できる最初のエントリが `body.model` になり、チェーンの残りはフォールバックリストとして付いていきます。走査が何も見つけなかったときの挙動は、プロファイル側の 2 点で決まります：

- `exhaustedBehavior` — レーンにエントリはあるが、全部がゲートで落ちたとき。`429`（デフォルト）は上流に触れずに `rate_limit_error` と `Retry-After` ヘッダをクライアントへ返します。`passthrough` は代わりに呼び出し側の `body.model` を、フォールバック無しでそのまま送ります。
- **エントリが 1 件も無い**レーンは、`exhaustedBehavior` が何であれ決して 429 になりません。未設定のレーンは「意見無し」であり、呼び出し側のモデルが送られたとおりに出ていきます。チェーンが読み込めないときも、ルーティングが他の理由で失敗したときも同じです — Rialto は振り先を捏造しません。`body.model` を書き換えるのはチェーンのエントリに置き換えるときだけです。

**パススルー**（`passthrough`、または予約プロファイル `passthrough` に固定されたアクセストークン）。呼び出し側の `body.model` が送られたとおりに上流へ出ます：`provider,model` か、有効なプロバイダーがちょうど 1 つだけ提供している bare なモデル名。このモードでは受け口が特定の `provider,model` を拒否できます。

どちらのモードでも、Providers ページで無効化したプロバイダーやモデルには決して送られません — チェーンのエントリからも、パススルーのリクエストからも、フェイルオーバー先としても、無効化されたサブスクリプションプロバイダーのアカウント経由でも。手で名指ししても転送されず、拒否されます。

### ルーティングシナリオ

**Routing** ページで各シナリオに使用するモデルを設定します：

| シナリオ | 適用タイミング |
|----------|--------------|
| `default` | 他のシナリオにマッチしないすべてのリクエスト |
| `think` | 拡張思考にオプトインしたリクエスト（`thinking.type` が `enabled` または `adaptive`。明示的な `disabled` は**含みません**）|
| `longContext` | トークン数が閾値を超えたリクエスト、または effort / ティアが「重い」と判定されたリクエスト |
| `webSearch` | `web_search*` ツールを伴うリクエスト |
| `image` | 画像関連タスク |

**`background` シナリオは存在しません。** マイグレーション `20260728_router_rules_drop_background` により `default` へ畳み込まれました。

各シナリオは 2 レーン — 通常トラフィック用の `agent` と、サブエージェントタグを持つリクエスト用の `subagent` — を持ち、レーンごとに独立した順序付きチェーンを持ちます。シナリオが選ばれるのは、そのレーンに使えるエントリが 1 件以上あるときだけで、無ければリクエストは `default` に落ちます。

**`longContext` の閾値は固定値ではありません。** プロファイルの制約（Routing ページ）に閾値が設定されていればそれが優先されます。未設定なら、チェーンの `default` / `agent` レーン先頭エントリが宣言するコンテキストウィンドウの 70 %（応答のためのヘッドルームを残す）。どちらも解決できないときにだけ 128 000 トークンへフォールバックします。

### effort・ティア・フォールバック

上記のシナリオトリガーに加えて、ルーターはリクエストをグレーディングし、順序付きフォールバックチェーンを辿ります：

- **グレーディングシグナル** — `output_config.effort`（`high`/`xhigh`/`max` → 重い → `longContext`、`low`/`medium` → 明示的に軽い）と、`body.model` から読む要求モデルティア（opus → 重い）。ティアは effort が無いときにだけ読むので、古い Claude Code のトラフィックも正しくグレーディングされます。effort で low/medium が明示されているときはティアによる昇格を抑制するので、呼び出し側から opus リクエストをダウングレードできます。
- **シナリオごとのフォールバックチェーン** — ルーターは `[primary, ...fallbacks]` を辿り、枯渇マークが付いておらず、かつ宣言済み `contextWindow` がリクエストを収容できる最初の候補を選びます。
- **能力ゲート** — 宣言された `contextWindow` がリクエストを収容できない振り先には絶対にフェイルオーバーしません。ウィンドウ未宣言のモデルは許可します（unknown = allow、保守的なデフォルト）。
- **429 でのアカウントローテーション** — サブスクリプションプロバイダーが 429 を返すと、そのサブアカウントを枯渇としてマークし（実際の `resetAt` まで、上流が示さなければ 5 分）、ピアアカウントで同じチェーンエントリを最大 10 回まで再試行します。ピアが尽きたときにだけプロバイダー全体をマークし、次のチェーンエントリへ進みます。
- **チェーンの順序は書かれたとおり** — `auth_mode` ゲートはありません。サブスクリプションの primary は、その後ろに書かれた api_key のフォールバックをそのまま保ち、同一プロバイダーのフォールバックも辿られます（枯渇は `(provider, model)` 単位でマークされるため）。サブスクリプションから従量課金へこぼしたくなければ、その後ろに api_key のエントリを書かないでください。
- **マルチアカウントバランシング** — 同一プロバイダーで複数の SubAccount が有効なとき、セッションルーターはまず記録済みのハードリミットウィンドウが 100 % に達しているアカウントを除外し、粘着中のセッション→アカウント対応が生き残りを指していればそれを再利用し、そうでなければ `残り % ÷ リセットまでの残り時間` が最大のアカウント — つまりクォータを使い残すリスクが最も高いアカウント — を選びます。

判断は構造化ログに残ります。先回りで primary を落としたときは `{ from, to, scenario, tokenCount, trace }` を、全候補が拒否されたときは dead-chain 警告を出すので、何が試されてなぜ落ちたかが追えます。`trace` の各エントリには `kept` / `exhausted` / `capability` / `malformed` のいずれかが付きます。

> **週次ドレインガードは存在しません。** 以前のビルドは、サブスクリプションプロバイダーの週次ウィンドウが線形ドレイン目標を超えると先回りで切り替え、その余裕幅を `Router.weeklyDrainMarginPct` で調整していました。どちらも削除済みです。サブスクリプションプロバイダーは上流の上限まで走り、実際に返ってきた 429 に反応してローテーションします — この信号だけは決して間違えないからです。

### ペルソナ

*ペルソナ*とは、シナリオ判定後にユーザー向けリクエストへ毎回追記される、名前付きのシステムプロンプト断片です。Claude Code 本体に手を入れずに、口調・役割・作業ルールを常時上乗せできます。

- **ライブラリ** — `Personas` はディスクエンベロープのトップレベル配列。各エントリは安定 uuid の `id`、表示用の `name`（一意でなくてよい）、本文の `prompt` を持ちます。新規インストールには小さなスターターライブラリが同梱されますが、既存環境はディスク上の既存内容を維持します。
- **アクティブ選択** — インストールごとに 1 つだけアクティブにできます。その uuid id はトップレベルの `ActivePersona` キーで、ディスクエンベロープでも `/api/config` のワイヤでも同じ場所にあります。`null` / 欠落 / 空文字は「ペルソナ無し」。プロジェクト別・セッション別のオーバーライドファイルはありません。
- **挿入方法** — ルーターがシナリオを解決すると、アクティブペルソナの `prompt` を、`cache_control` を持つ最後の system ブロック（無ければ最後の文字列テキストブロック）に追記します。これによりペルソナはキャッシュプレフィクスの*内側*に収まり、追加のキャッシュブレークポイントを消費せず、リクエスト間でバイト単位の安定性が保たれます（Anthropic のプロンプトキャッシュが維持される）。`system` が文字列 / 未定義のときは結合、複数ブロックの配列のときはその場で更新します。
- **受け口による制限** — ペルソナ挿入が走るのは **`/v1/messages` だけ**、しかも routed なトラフィックだけです。passthrough の受け口や `passthrough` プロファイルに固定したトークンはルーターを丸ごと飛ばすので、ペルソナも付きません。OpenAI 互換面と Gemini 面は肥大化した `system` フィールドをそもそも受け付けない（Codex は `Unsupported parameter: system` を返す）ため、リクエストを壊すよりはと挿入をスキップしています。`/v1/messages` 上では**全シナリオ**がアクティブペルソナを継承します — シナリオ単位の除外はありません。
- **サブエージェントとの相互作用** — ペルソナ挿入はサブエージェントタグ処理の*後*で走るので、サブエージェント呼び出しごとの system 内容を上書きせず、ペルソナと合成されます。

ライブラリ管理もアクティブペルソナの切り替えも **Settings → Personas**（`/settings/personas`）で行います。「ペルソナ無し」がデフォルトの no-op です。

再現精度の高いペルソナを書くための実践ガイド（構造パターン・アンチパターン列挙・`think` リクエスト向け思考制御）は [docs/guides/persona-authoring.md](docs/guides/persona-authoring.md) を参照してください。

### トランスフォーマー

トランスフォーマーはリクエストを各プロバイダのワイヤ形式に変換します。Rialto に同梱されるのは 6 つで、その集合はビルド時に固定されます（プラグインローダーはありません）。

| トランスフォーマー | 束縛先 | 役割 |
|-------------|----------|-----|
| `anthropic` | `/v1/messages` | Anthropic ネイティブのワイヤ形式 |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions |
| `openai-responses` | `/v1/responses` | OpenAI Responses API — Codex 系モデル |
| `gemini` | `/v1beta/models/:modelAndAction` | Google Gemini |
| `claude-code-oauth` | サブスクリプション認証 | Claude Code の OAuth bearer を注入（自動リフレッシュ付き） |
| `codex-oauth` | サブスクリプション認証 | ChatGPT / Codex の OAuth bearer を注入 |

**チェーンは設定するものではなく、導出されるものです。** 上記はいずれもエンドポイント束縛か認証束縛であり、選ぶ余地がありません。Rialto はプロバイダの API スタイルと認証モードからチェーンを決定します。

| API スタイル | api_key | subscription |
|---|---|---|
| `anthropic` | *（変換段は不要）* | `claude-code-oauth` |
| `openai_chat` | `openai` | *未対応* |
| `openai_responses` | `openai-responses` | `openai-responses` → `codex-oauth` |
| `gemini` | `gemini` | *未対応* |

Anthropic プロバイダに変換段が無いのは、リクエストが既にそのワイヤ形式だからです。未対応の組み合わせでは、認証情報なしで呼び出すのではなく、プロバイダ自体が登録されません。

モデル自身の API スタイルがプロバイダのそれと食い違う場合（通常の OpenAI プロバイダ上にある Codex 系モデルなど）、そのモデルのリクエストにだけ変換段が追加されます。

`provider.transformer.use` はもう読まれません。古い設定に残った `use` ブロックは読み込み時に破棄されます。導出されたチェーンは Providers ページの **Request shape** に読み取り専用で表示され、リクエストの挙動がおかしいときに最初に見るべき情報です。

### サブエージェントルーティング

プロンプト中のサブエージェントタグは、そのサブエージェントをシナリオの **`subagent` レーン**へ振り分けます：

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
このコードの分析をお願いします...
```

**意味を持つのはタグの有無だけで、中身は無視されます。** タグはレーンを選ぶだけで、モデルは **Routing** ページ上のそのレーンの設定から来ます。これは意図的な設計です — サブエージェントのルーティングを、各サブエージェントのプロンプトファイルに散らすのではなく 1 箇所で編集できるようにするためです。タグは上流へ送る前に除去されるので、この目印がベンダーに届くことはありません。

`<CCR-SUBAGENT-MODEL>` はリネーム前の綴りで、既に書かれているプロンプトの中に生きているため引き続き受理されます。中身に古い `provider,model` の組を書いたままのタグも動作します — その組が読まれないだけです。

## 🔀 OpenAI 互換・Gemini 互換の受け口

OpenAI SDK の呼び手（Codex CLI、Cline、OpenWebUI、Python / JS の `openai`、`curl`）も、Gemini SDK の呼び手も、あなたの**サブスクリプション枠**（Claude Max、ChatGPT Plus/Pro）を素のベンダーエンドポイントのように消費できます。呼び手から見えるのは通常のリクエスト / レスポンスですが、Rialto の裏では OAuth 認証済みのアカウントへ流れるので、コストは従量課金の API 請求ではなく月額サブスクリプションの内側に留まります。

### エンドポイント（OpenAI ワイヤ形式）

| メソッド | パス | 備考 |
|---|---|---|
| `GET`  | `/v1/models`             | DB 由来の有効モデル一覧を `{object:'list', data:[…]}` で返します。各 `id` は Rialto の正準形 `provider,model` なので、そのまま次の呼び出しに使い回せます。 |
| `POST` | `/v1/chat/completions`   | 標準の Chat Completions — ストリーム / 非ストリーム両対応。body の `model` には `/v1/models` の `provider,model` id を渡します。 |
| `POST` | `/v1/responses`          | OpenAI Responses API — ストリーム / 非ストリーム両対応。モデル指定は上と同じ。 |

この 3 パスの認証は **`Authorization: Bearer <発行済みアクセストークン>` のみ**です（`x-api-key` は Anthropic の規約なのでここでは拒否され、401 の body は OpenAI の `{error:{message,type,code}}` 形式に従います）。Anthropic 面（`/v1/messages`）は追加で `x-api-key` も読みますが、値はやはり発行済みアクセストークンでなければなりません。

### 例 — OpenAI Python SDK から Codex サブスクリプションを使う

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="rialto_your-access-token",   # Settings → Access。APIKEY ではありません
)

# 1. ルーティング可能なモデルを列挙
for m in client.models.list().data:
    print(m.id, m.owned_by)
# → codex,gpt-5.6-luna  (owned_by=codex)
# → claude-code,claude-sonnet-5  (owned_by=claude-code)
# ...

# 2. Chat Completions（Codex Plus/Pro サブスクリプション経由でルーティング）
res = client.chat.completions.create(
    model="codex,gpt-5.6-luna",
    messages=[{"role": "user", "content": "reply pong"}],
)
print(res.choices[0].message.content)  # → pong
```

### 例 — OpenAI JS SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: process.env.RIALTO_ACCESS_TOKEN, // Settings → Access
})

const stream = await client.chat.completions.create({
  model: 'codex,gpt-5.6-luna',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

`base_url` / `baseURL` を上書きできるクライアントなら同じように動きます。

**これらの受け口で何が効くか。** フェイルオーバー、アカウントローテーション、`provider,model` 形式のモデル指定は常に効きます。チェーンルーティングは、その受け口を `passthrough` から `routed` に切り替えて初めて効きます。ペルソナ挿入は効き**ません** — `/v1/messages` 専用です（上記「ペルソナ」参照）。

## 📊 ログ

- **サーバーレベルログ**（pino）：`~/.rialto/logs/rialto-*.log` — HTTP リクエスト、API コール、サーバーイベント。レベルは `LOG_LEVEL` で制御。
- **アプリレベルログ**：`~/.rialto/rialto.log` — ルーティング決定とビジネスロジックイベント。

どちらも UI の **Activity → Logs** から閲覧できます。

## 🌐 外部公開

トンネル越しに Rialto を公開する場合、`/api/*` と `/v1/*` は別扱いが必要です — 前者は Cloudflare Access の背後に、後者はエッジで Bypass して発行済みトークンだけを門にします。設定手順と、CLI クライアントがログイン画面で詰む失敗モードは [docs/guides/public-deployment.md](docs/guides/public-deployment.md) にまとめてあります。

## ⬆️ リネーム前ビルドからの移行

ホームディレクトリ、環境変数、データベース名、Docker イメージ、thinking signature のプレフィクスはいずれも Rialto へのリネームで変わりました。[docs/guides/migration-v3.md](docs/guides/migration-v3.md) を参照してください。

## 🛠️ 開発

### 前提条件

- Bun ≥ 1.1.0
- PostgreSQL
- Redis

デブコンテナ（`.devcontainer/compose.yaml`）が `postgres` と `redis` を自動的に提供し、新規ボリュームでは独立したテスト用データベース `rialto_test` も作成します。

### セットアップ

```shell
bun install
```

```shell
# .env
DATABASE_URL=postgres://postgres:password@postgres:5432/rialto
TEST_DATABASE_URL=postgres://postgres:password@postgres:5432/rialto_test
REDIS_URL=redis://redis:6379
```

```shell
bun run db:migrate
bun run dev         # Vite（ポート 16175）。SPA に加えて @hono/vite-dev-server 経由で
                    # /api/*・/v1/*・/health・/callback の Hono アプリも提供します
```

### ビルド

```shell
bun run build       # Vite プロダクションビルド（単一ファイル出力 → dist/）
```

### テスト

```shell
bun test                  # フルスイート
bun run test              # __tests__/lib __tests__/db __tests__/preset のみ
bun run test:providers    # プロバイダー契約テスト（フィクスチャ再生）
```

`bun test` と `bun run test` は**別のコマンド**です。CI は Build / Type Check / Test の 3 ゲートを回します。

### チェック

```shell
bunx tsc --noEmit
bunx biome check --write .
bunx knip                 # デッドコード棚卸し
```

### データベースツール

| スクリプト | 目的 |
|-----------|------|
| `bun run db:generate` | Prisma クライアント再生成（`postinstall` でも走ります）|
| `bun run db:migrate` | マイグレーション作成・適用（開発）|
| `bun run db:migrate:deploy` | 既存マイグレーション適用（本番 / CI）|
| `bun run db:migrate:test` | 独立したテスト用データベース `rialto_test` へ適用 |
| `bun run db:reset` | スキーマ削除・再作成（破壊的）|
| `bun run db:seed` | 冪等なシード — `live` 選好プロファイル |
| `bun run db:studio` | Prisma Studio を開く |

DDL を直接編集せず、必ず Prisma マイグレーションを使用してください。**マイグレーション後は `db:migrate:test` も必ず流すこと** — さもないとテスト用データベースに対して CI が落ちます。

### 価格スクレイピング

| スクリプト | 目的 |
|-----------|------|
| `bun run scrape:openai-prices` | OpenAI モデル価格をスクレイピング |
| `bun run scrape:anthropic-prices` | Anthropic モデル価格をスクレイピング |
| `bun run scrape:google-prices` | Google / Gemini 価格をスクレイピング |
| `bun run scrape:prices` | 上記すべてをスクレイピング |
| `bun run seed:prices-db` | スクレイピングした価格をデータベースへ投入 |

### リリース

| スクリプト | 目的 |
|-----------|------|
| `bun run release` | ビルドして Docker イメージを公開 |
| `bun run release:docker` | Docker イメージのみ公開 |

### アーキテクチャドキュメント

- [`docs/architecture/inbound-surfaces.md`](docs/architecture/inbound-surfaces.md) — 受け口レジストリと、そこから導出されるもの
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — 起動 → リクエスト → upstream → 応答整形の通し動線
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — ルーティング判断と 429 ローテーションの拡大図
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — テストがどこにあり、何を担保しているか

## ライセンス

MIT — `LICENSE` を参照。
