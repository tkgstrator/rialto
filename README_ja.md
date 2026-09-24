[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> LLM トラフィックのルーティングゲートウェイ。4 つのワイヤ形式を受け口で受け取り、設定したベンダーへ振り分けます — クライアント側の設定を変えることなく。

## ✨ 機能

- **4 つの受け口（inbound surface）** — Anthropic Messages（`/v1/messages`）、OpenAI Chat Completions、OpenAI Responses、Gemini `generateContent`。受け口に必要な知識は記述子 1 つに集約されているので、4 面すべてが同じ認証・エラー封筒・ストリーミング・リクエスト履歴を得ます。
- **シナリオ別ルーティング** — 各リクエストをシナリオ（Default、thinking を求めるなら Think、自動で調整されるしきい値を超える入力なら Long context）とレーン（エージェント本体か、サブエージェントか）に分け、プロファイルがシナリオとレーンごとに持つ順序付きのルートのリストで振り分けます。各ルートはプロバイダーとそのプロバイダー上のティアを名指しし、それがどのモデルかはプロバイダーの*ティアエイリアス*が決めるので、新モデルが出てもすべてのルートではなくエイリアスを 1 つ動かすだけで済みます。リクエストを受けられる最初のルートが処理し — クォータを使い残しそうなルートは先頭へ、尽きそうなルートは後ろへ回ります — 残りがフォールバックリストになります。
- **パススルー** — あるいは呼び出し側に選ばせる：passthrough モードの受け口（または 1 本のアクセストークン）では、呼び出し側の `body.model` がそのまま上流へ送られます。
- **アカウントローテーション付きフェイルオーバー** — 429 を受けたらまずピアのサブスクリプションアカウントへ回し、それでも駄目ならそのリストの残りのルートを進みます。リストの順序は書かれたとおりに守られ、サブスクリプションのルートから api_key のルートへ落ちることも含まれます。
- **ペルソナ** — Claude Code 本体に触らずに、routed な `/v1/messages` のリクエストへ毎回名前付きのシステムプロンプトを追記。ライブラリの管理もアクティブなペルソナの選択も Settings → Personas で行います。
- **マルチプロバイダー対応** — API キー型プロバイダー（Anthropic、OpenAI、DeepSeek、Gemini、Groq、OpenRouter など）やサブスクリプション型プロバイダー（Claude Code OAuth、OpenAI Codex）に接続。サブスクリプション型は 1 プロバイダーに複数アカウントを持てます。
- **サブスクリプション監視** — 各アカウントのレート制限ウィンドウを、Subscriptions 一覧から任意のタイミングで更新でき、ルーターが読む枯渇状態もここに反映されます。更新はすぐにルーティングへ届き、Codex アカウントがバンクしたレート制限リセットはプロバイダーのページから使えます。
- **使用量・コスト** — Overview に今日・今週・今月の支出、Activity → Usage に日別 / 週別のプロバイダー別コストとアカウント別のサブスクリプション使用量。Overview と各サブスクリプションプロバイダーのページには、アカウントごとに、そのトラフィックを API 価格で払った場合の額（今週と直近 30 日）も表示します。
- **リクエスト履歴** — 過去のセッションをリクエスト単位の統計・アーカイブ済み会話とともに閲覧。
- **発行型アクセストークン** — 個別に失効・ローテートでき、リクエスト単位で帰属が取れ、複数の受け口と 1 つのルーティングプロファイルにスコープできます。
- **Web 管理 UI** — ブラウザで完結する設定管理（英語・日本語・中国語）。手動 JSON 編集不要。
- **トランスフォーマーパイプライン** — チェーンはプロバイダーの API スタイルと認証モードから導出されるので、UI が見せているものと実際に走るものが食い違いません。
- **Docker ファーストデプロイ** — PostgreSQL と Redis を含む `docker compose up -d` 一発起動。

## 🖥️ Web UI

Web UI（デフォルトでポート **3456** で提供）でゲートウェイのあらゆる設定を管理できます。画面は 6 つで構成されています：

| 画面 | ルート | 目的 |
|------|--------|------|
| **Overview** | `/overview` | 支出、サブスクリプションのクォータウィンドウ、受け口ごとのリクエスト数 / エラー数を一望 |
| **Routing** | `/routing` | 受け口ごとのルーティングモードとプロファイル。シナリオ（Default / Think / Long context）とレーン（Agent / Subagent）ごとに、順に試すプロバイダー · ティアのルートと、いま効いている Long context のしきい値。パススルー受け口で名指しできる振り先 |
| **Providers** | `/providers` | 2 つの一覧 — `/providers/subscriptions` と `/providers/api-keys` — に加え、追加用の `/providers/connect` と、ティアエイリアス・モデル・価格・コンテキストウィンドウ・接続テスト・導出された Request shape（読み取り専用）を見る `/providers/<name>` |
| **Access tokens** | `/access-tokens` | クライアントが `/v1/*` で使うトークンの発行・スコープ設定・ローテート・失効 |
| **Activity** | `/activity` | セッション、リクエスト単位のログ（`/activity/requests`）、サブスクリプション使用量（`/activity/usage`）、サーバーログ（`/activity/logs`）|
| **Settings** | `/settings` | Server、Access（管理アクセス：Cloudflare Access と、それが壊れたときの入り直し方）、Logging、Personas、Status line、Advanced（設定ドキュメント、ヘルス）|

初回起動は `/setup` に着地します。

> 現行 UI のスクリーンショットはまだありません。以前 `docs/images/` にあった画像は廃止済みの旧 UI を写していたため、誤った製品像を残すよりはと判断して削除しました。

## 🚀 Docker クイックスタート（推奨）

[Docker](https://docs.docker.com/get-docker/) と [Docker Compose](https://docs.docker.com/compose/install/) をインストール後：

**ステップ 1 — 作業ディレクトリを作成し、`compose.yaml` をダウンロード：**

```shell
mkdir -p ~/rialto
cd ~/rialto
curl -fsSL https://raw.githubusercontent.com/tkgstrator/rialto/master/compose.yaml -o compose.yaml
```

この compose ファイルは `ghcr.io/tkgstrator/rialto:latest` を PostgreSQL・Redis と一緒に起動し、ポート `3456` を公開し、`./rialto-config` をコンテナの `~/.rialto` としてバインドマウントします — ホスト側で `config.json` が置かれるのはこのディレクトリです。CLI の認証情報ファイル用に `~/.claude` と `~/.codex` もマウントしますが、API キー型プロバイダーしか使わないならその 2 行は削って構いません。

設定ファイルは初回起動時に自動生成されるので、起動前に書くものはありません。エンベロープのスカラー値は `rialto` サービスの環境変数（`PORT`、`LOG_LEVEL` など）としても渡せます。環境変数が設定されていればファイルより優先されます。

> **管理キーはありません。** Rialto が動いているマシン上のブラウザは管理ゲートを免除され、リモートからの管理アクセスは Cloudflare Access を通ります。Access が壊れたときは、ホストへ SSH してポートを転送します — [外部公開](#-外部公開) を参照。
>
> **`/v1/*` を通すのはアクセストークンだけです。** クライアントは **Access tokens** 画面で発行する*アクセストークン*で接続します。個別に失効でき、リクエスト単位で帰属が取れ、受け口とルーティングプロファイルにスコープできます。トークンを 1 本も発行していないインストールはプロキシを通せません。

**ステップ 2 — サービスを起動：**

```shell
docker compose up -d
```

エントリポイントがサーバー起動前に未適用の Prisma マイグレーションとシードを適用します。その後サーバーが `http://127.0.0.1:3456` で待ち受けます。ブラウザで開き、**Providers** ページと **Routing** ページで設定を完了します。続けて **Access tokens** でトークンを発行してください — クライアントが認証に使うのはこちらです。

**ステップ 3 — Claude Code からゲートウェイに接続：**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

シェル設定ファイルに永続的に追記する場合：

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**ステップ 4 — 使う受け口のルーティングを有効化：**

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

**Providers** ページで **Add provider** を選び、ベンダー（Anthropic、OpenAI、DeepSeek、Gemini など）を選択して API キーを貼り付け、有効にするモデルを選びます。キーは `config.json` ではなくデータベースに保存されます。ルーティング先になれるのはここで有効化したモデルだけで、残りは一覧に残るので後から有効化できます。

### サブスクリプション型プロバイダー（Claude Code・Codex）

Rialto はサブスクリプション型プロバイダーを API キーなしでルーティングに利用できます。**Providers → Add provider** から追加してください。2 社の OAuth クライアントは戻り先が異なるため、認証ステップの選択肢はベンダーごとに違います。

**Claude**

- **Sign in with Anthropic** — Anthropic の OAuth ページをブラウザで開きます。戻り先は `http://localhost:3456/callback` です。
- **リダイレクト URL を貼り付け** — ブラウザがそのコールバックに届かないとき（トンネル越しの Rialto や、ヘッドレス環境）は、Anthropic がリダイレクトした先の URL をコピーして入力欄に貼り付けます。コード交換はサーバー側で行われます。
- **Import from Claude** — 既にサインイン済みのマシンから `~/.claude/.credentials.json` をアップロードします。

**Codex**

- **Device code**（既定）— Rialto がワンタイムコードとリンク `https://auth.openai.com/codex/device` を表示します。任意のブラウザでリンクを開き、ChatGPT にサインインしてコードを入力すると、画面は自動で次へ進みます。コードの有効期限は 15 分です。Rialto に戻ってくる通信が要らないので、トンネル越しやコンテナ内でも使えます。`codex login --device-auth` と同じフローです（`POST /api/oauth/device/start` → `POST /api/oauth/device/poll`）。
- **Import from Codex** — 既にサインイン済みのマシンから `~/.codex/auth.json` をアップロードします。

Codex のブラウザーサインインは提供していません。OpenAI の OAuth クライアントは「ブラウザが動いているマシン」の `http://localhost:1455/auth/callback` にしか戻らず、リモートやコンテナで動く Rialto には届かないためです。その裏にあるループバックリスナー（ポート `1455`、`compose.yaml` は引き続き公開しています）は UI からは使われなくなりました。

Rialto は暗号化したトークンを保存し、更新も行います。1 つのプロバイダーに複数アカウントを持てて、どのアカウントがリクエストを処理するかはリクエストごとに決まります（[フェイルオーバーとアカウントローテーション](#フェイルオーバーとアカウントローテーション) を参照）。Subscriptions 一覧の **Refresh** ボタン（`POST /api/subscriptions/refresh`）は、有効なサブスクリプションプロバイダー上の全アカウントを再同期し、5 分キャッシュを越えて使用量を取り直します。ルーティングは次のスケジューラ tick を待たずに新しい値を読みます：Refresh はクォータのスナップショットを作り直し、ベンダー側でリセット済みのアカウントに以前の 429 が残した枯渇マークを外します。

Codex のアカウントは*バンク済み*のレート制限リセットを持てます。プロバイダーのページのアカウント行にその残数が出て、**Use reset** で 1 つ使えます（`POST /api/subscriptions/accounts/{id}/reset-usage`）。使う前の確認には、次に失効するものの期限が出ます。ボタンが押せるのはベンダーがリセットを受け付けるとき、つまりいずれかのウィンドウを使い切っているときだけです。その後アカウントの使用量は Refresh と同じ経路で取り直されるので、リセットが反映されしだいルーティングがそのアカウントを使います。リセットを自動で使うことはありません。

> **利用規約に関する注意：** Claude Code のサブスクリプションを Claude Code 以外のアプリケーションからのリクエストに使用することは、[Anthropic の利用ポリシー](https://www.anthropic.com/legal/aup) に違反する可能性があります。この機能の使用は自己責任で判断してください。

## 🚪 受け口（inbound surface）

Rialto は Claude Code 専用プロキシではありません。受け口で 4 つのワイヤ形式を受け取り、それぞれ `src/llms/inbound/surfaces.ts` の記述子 1 つで記述されています：

| 受け口 | パス | 想定クライアント | 認証情報 | エラー封筒 |
|---|---|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | Claude Code | `x-api-key` または `Authorization: Bearer` | `{type:'error', error:{type,message}}` |
| `openai-chat` | `POST /v1/chat/completions` | OpenAI SDK、Cline、OpenWebUI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `openai-responses` | `POST /v1/responses` | Codex CLI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `gemini-generate` | `POST /v1beta/models/<model>:<action>` | Gemini CLI | `x-goog-api-key`、`?key=`、または `Authorization: Bearer` | `{error:{code,message,status}}` |

`GET /v1/models` と `POST /v1/messages/count_tokens` は完了リクエストの面ではなくカタログ読み出しなので、4 面には含まれません。ただし呼び手の SDK に合わせた認証規約とエラー封筒で返し、一部の受け口にスコープされたトークンからも呼べます。

どの受け口に来たリクエストでも、認証情報は**発行済みアクセストークン**でなければなりません。それ以外は受理されません。

### ルーティングモード

各受け口は保存済みのモードを 1 つ持ちます：

| モード | 挙動 |
|---|---|
| `passthrough` | モデルは呼び出し側が選ぶ。ルーティングはスキップ。 |
| `routed` | シナリオ別ルーティングを走らせる：シナリオとレーン → すべてのゲートを通り、ペースで並べた最初のルート → フェイルオーバー。 |

**すべての受け口は `passthrough` で始まります。** 未設定のインストールでルーティングを走らせても意味がない（ルートが無ければすべてのリクエストが呼び出し側のモデルへ素通りする）ので、ルーティングは振り先が揃ってから受け口ごとに有効化するものとしてあります。各受け口はルーティングプロファイル（デフォルトは `live`）からルートを引きます。Routing ページのプロファイル選択で、たとえば CI クライアントが叩く受け口だけ cost-first のプロファイルに向ける、といった運用ができます。2 つ目のプロファイルは書き込むことで作られます：`PUT /api/routing/profiles/<key>`。各モードが `body.model` をどう扱うかは [シナリオ別ルーティングとパススルー](#シナリオ別ルーティングとパススルー) を参照。

## ⚙️ 設定

### ディスクエンベロープ（`~/.rialto/config.json`）

起動時のスカラー値とディスク常駐オブジェクトを格納します。環境変数補間（`$VAR` / `${VAR}`）と JSON5 コメントをサポート。**バックアップはありません**：保存のたびにファイルはその場で上書きされ、唯一の安全網は、パースできないファイルを削除せず脇へ改名する（`config.json.invalid-<timestamp>`）ことだけです。スキーマが知らないキーも破棄されず保持されます。

| キー | 説明 |
|------|------|
| `HOST` | リスニングアドレス（デフォルト：`127.0.0.1`）|
| `PORT` | リスニングポート（デフォルト：`3456`）|
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access のチームドメイン。`ACCESS_AUD` と併せて `/api/*` の assertion を検証します |
| `ACCESS_AUD` | Access アプリケーションの AUD タグ。**両方揃わないと有効になりません** |
| `LOG` | `true` でログファイルを書き出す（デフォルト `false`）|
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace`（デフォルト `info`）|
| `LOG_MAX_MB` | ログファイルをローテーションするサイズ（MB、デフォルト `10`）|
| `PROXY_URL` | アップストリーム API リクエスト用 HTTP プロキシ |
| `API_TIMEOUT_MS` | Bun のリクエスト単位アイドルタイムアウト（ms）。秒に変換して 1〜255 秒にクランプされます（デフォルト 255 秒）。アップストリーム呼び出しのタイムアウトではありません |
| `CLAUDE_PATH` | 宣言・編集はできますが、このビルドでは何も読みません — CLI が存在しないため |
| `NON_INTERACTIVE_MODE` | 宣言・編集はできますが、このビルドでは何も読みません |
| `CAPTURE_REQUESTS` | リクエストごとに `RequestLog` 行を記録（デフォルト `true`）|
| `CAPTURE_MESSAGES` | 会話のトランスクリプトをアーカイブ（デフォルト `true`）|
| `REDACT_TOOL_ARGUMENTS` | ツール呼び出しの引数をアーカイブから除去（デフォルト `false` — 有効化すると後から復元できない情報が失われるため）|
| `ROUTING_SCHEDULER_INTERVAL_MS` | スケジューラの tick 間隔、60 000〜3 600 000（デフォルト `300000`）|
| `Personas` | ペルソナライブラリ（配列）|
| `ActivePersona` | アクティブなペルソナの uuid id。`null` / 欠落 / 空文字は「無し」。`/api/config` のワイヤ上でもトップレベルキーです |
| `StatusLine` | Settings → Status line で編集するステータスラインのレイアウト。プレビュー専用で、このビルドにはこれを描画するものがありません |

上記のスカラーキー（`Personas`・`ActivePersona`・`StatusLine` 以外）はプロセスの環境変数 — たとえば Docker の `environment:` — としても渡せ、環境変数が設定されていればファイルより優先されます。

旧ビルドが、もう存在しない機構のために書いたキーは無視されます。`Router`、`CUSTOM_ROUTER_PATH`、`LiveRoutingName`、`CROSS_PROVIDER_FALLBACK`、そして廃止された管理キー `APIKEY` は読み込みのたびに取り除かれ、`POST /api/config` は警告を出してこれらを捨て、次の保存でファイルからも消えます。環境変数の `APIKEY` も読まれません。`ROUTER_MODE` は未知のキーとして残るだけで、何も読みません。

### プロバイダー・モデル・ルート（データベース）

プロバイダー・モデル・ティアエイリアス・プロファイルごとのルート・受け口ごとのルーティングモードは PostgreSQL に置かれ、Web UI（`POST /api/config`、`PUT /api/providers/{name}/tier-aliases/{tier}`、`PUT /api/routing/profiles/{key}`、`POST /api/inbound-surfaces`）から管理します。`config.json` の**中にある** `Providers` キーは、保存のたびにデータベースから書き戻される一方向のミラーです。手で書き換えても効果はなく、次の書き込みで上書きされます。ルーティングに関するものはもうディスクへミラーされません。

### シナリオ別ルーティングとパススルー

Rialto が `body.model` に対してすることは、この 2 つだけです。

**シナリオ別ルーティング**（`routed`）。リクエストはプロファイル — アクセストークンがプロファイルを指定していればそれ、無ければ受け口のプロファイル、それも無ければ `live` — を通ってルーティングされ、*シナリオ*と*レーン*に分類されます：

- 入力が [Long context のしきい値](#long-context-のしきい値)を超えれば **Long context**、そうでなく thinking を求めていれば **Think**（Anthropic の `thinking` は `disabled` 以外、OpenAI の `reasoning_effort` / `reasoning` は `none` 以外、Gemini の `thinkingConfig`）、どちらでもなければ **Default**。
- [サブエージェントタグ](#サブエージェントタグ)があれば **Subagent** レーン、無ければ **Agent** レーン。

呼び出し側が送ったモデル名は、何も選びません。プロファイルはシナリオとレーンごとに順序付きのルートのリストを持ち、各ルートはプロバイダーとそのプロバイダー上のティアを名指しします（`claude-code · sonnet`）。それが今どのモデルかは、そのプロバイダーの[ティアエイリアス](#ティアエイリアス)が決めます。Think か Long context のリストに、そのレーンで使えるルート — 有効で、エイリアスが設定され、有効なモデルに届くもの — が 1 本も無ければ、同じレーンの Default のリストが引き受けます。

ルートは順に試され、次のゲートをすべて通ったルートだけが処理できます：

1. ルート、そのモデル、そのプロバイダーがいずれも有効である。
2. ルートが名指ししたティアのエイリアスが、そのプロバイダーに設定されている。
3. リクエストが Web 検索ツールを伴うなら、モデルがそれを実行できる — Anthropic・OpenAI Responses・Gemini のリクエスト形式は運べるが、Chat Completions は運べない。
4. モデルのコンテキストウィンドウにプロンプトが収まる（ウィンドウ不明は許可）。
5. クォータが尽きていない：以前の 429 によるそのモデル / プロバイダーの枯渇マークが無く、ルーティングスケジューラのスナップショットが使い切り、あるいはプロファイルの `quotaSkipPct` 以上の使用を報告していない（読み取り値を持つのはサブスクリプションの振り先だけ）。
6. 直近 5 分のエラー率が `errorRateSkipPct` 未満である（サンプルが `minHealthSamples` 件以上あるときだけ判定）。

通ったルートは、次に**ペース** — このペースで使い続けたら各ルートのサブスクリプションのクォータがリセット時点で何 % になるか — で並べ替えられます。予算の 60 % 未満で終わりそうなルートは先頭へ（払っているクォータを使い残さないため）、100 % を超えそうなルートは末尾へ（上限に達する前に、その下に書いたルートが先に使われるように）移り、それ以外と、読み取り値の無い api_key のルートは書いた順のままです。全ルートが超過なら書いた順が保たれます — 見込みだけでリクエストを断ることはありません。先頭のルートが `body.model` になり、残りはその順にフォールバックリストとして付いていきます。1 本も通らなかったときは、その理由で応答が決まります：

| 状況 | 応答 |
|---|---|
| そのレーンの Default のリストにルートが無い、またはすべてのルートかその振り先が無効 | 呼び出し側の `body.model` が送られたとおりに出ていく。`exhaustedBehavior` が何であれ**決して 429 にならない** — 未設定のリストは「意見無し」 |
| 少なくとも 1 本がクォータかエラー率で止められた | `exhaustedBehavior` に従う。`429`（デフォルト）は上流に触れずに `rate_limit_error` と `Retry-After` ヘッダ — 止められたルートのうち最初に復帰するものまでの秒数（その 429 マークの期限、無ければスナップショット上のリセット。どちらも不明なら 30）— を返す。`passthrough` は代わりに呼び出し側の `body.model` を、フォールバック無しで送る。クォータで止められた Think や Long context のリストが Default のルートを借りることはない |
| クォータで止められたルートは無いが、どのルートも*この*リクエストを受けられない — エイリアス未設定、Web 検索不可、プロンプトが大きすぎる | 受け口のエラー封筒で **400**（`invalid_request_error`、Gemini 面では `INVALID_ARGUMENT`）。待っても変わらないので、429 に見せかけない |

プロファイルが読み込めないときも、ルーティングが他の理由で失敗したときも、呼び出し側のモデルが送られたとおりに出ていきます。Rialto は振り先を捏造しません。`body.model` を書き換えるのはルートのモデルに置き換えるときだけです。

プロファイルは制約も 4 つ持ち、`PUT /api/routing/profiles/{key}` で設定します（Routing ページには出ません）：`exhaustedBehavior`（`429` / `passthrough`）、`quotaSkipPct`（デフォルト 100）、`errorRateSkipPct`（比率、デフォルト 0.5）、`minHealthSamples`（デフォルト 5）。

**パススルー**（`passthrough`、または予約プロファイル `passthrough` に固定されたアクセストークン）。呼び出し側の `body.model` が送られたとおりに上流へ出ます：`provider,model` か、有効なプロバイダーがちょうど 1 つだけ提供している bare なモデル名。このモードでは受け口が特定の `provider,model` を拒否できます（Routing → Reachable targets）。

どちらのモードでも、Providers ページで無効化したプロバイダーやモデルには決して送られません — ルートからも、パススルーのリクエストからも、フェイルオーバー先としても、無効化されたサブスクリプションプロバイダーのアカウント経由でも。手で名指ししても転送されず、拒否されます。

リクエストを処理したシナリオ — または `passthrough` — はリクエストログに記録され、Activity で **Scenario** として表示されます。詳しいリファレンスは [docs/architecture/routing.md](docs/architecture/routing.md) です。

### Long context のしきい値

リクエストを Long context とみなす入力の大きさは、自分で決めるものではありません。出発点は、Default · Agent の先頭の使えるルートが届くモデルのコンテキストウィンドウの 70 %（残りは応答の余地）で、それが不明なら 128 000 です。つまりそのルートのエイリアスに追従します。そのうえでルーティングスケジューラが、Long context · Agent の先頭ルートのペースを見て、1 日 1 回まで 20 % ずつ動かします — そのルートがクォータを使い残しそうなら下げて、より多くのリクエストを回し、尽きそうなら上げます。30 000 より下にも、出発点より上にもなりません（それより大きなリクエストは、残される Default のモデルに収まらないため）。ルートが受け止めきれなかった引き下げ — その日のうちに尽きた — は元に戻されます。いま効いている値は Routing ページの Long context の行に出ます。プロファイルの制約で `autoTuneLongContext: false` にすれば調整は止まりますが、値を手で決める方法はありません。

### ティアエイリアス

ルートが名指しするのはプロバイダーとティアで、モデルではありません。`claude-code · sonnet` がどのモデルかは、そのプロバイダーの*ティアエイリアス*が決めます。プロバイダーのページにある **Tier aliases** 欄で、`fable`・`opus`・`sonnet`・`haiku` の枠ごとに設定します。ベンダーが新しい Sonnet を出したら、そのエイリアスを 1 つ動かすだけで、そのプロバイダーの Sonnet を指すルートがすべて追従します。

**エイリアスが勝手に動くことはありません。** カタログの Refresh は新モデルを見つけられますし、その欄はそれを候補として数えます（「1 new」）。しかし新モデルの価格・利用資格・挙動は、Sonnet への要求がすべてそこへ流れる前に人が確かめるべきものです。ピッカーでそのモデルを選んでページを保存すると、エイリアスがそこを指し、モデルも有効になります。ピッカーには名前がそのティアを示すモデルだけでなく、プロバイダーが持つモデルがすべて出るので、モデル名が Claude の系列を示さないプロバイダー — Codex、OpenAI — にもエイリアスを付けられます。

Claude のサブスクリプションプロバイダーは、モデルが作られた時点でプリセットのデフォルトモデルからエイリアスが自動で付くので、接続直後からルーティングできます。Codex のモデル名は Claude の系列を示さないので、エイリアスは自分で設定します。

エイリアス未設定のルートは残ります（保存は警告を出すだけ）が、リクエスト時には飛ばされます。Routing ページでは、モデルの無いティアは選べません。その結果 Think か Long context のリストに使えるルートが無くなれば Default が引き受け、Default がそうなってクォータで止められたルートも無ければ、上のとおり 400 で拒否されます。

### フェイルオーバーとアカウントローテーション

リストのルートがそのままフォールバックリストです。1 本のルートの中では、まずサブスクリプションプロバイダーのアカウントを回します：

- **429 でのアカウントローテーション** — サブスクリプションプロバイダーが 429 を返すと、そのサブアカウントを枯渇としてマークし（90 % 以上埋まっている束縛ウィンドウのリセットまで。不明なら 5 分）、ピアアカウントで同じ振り先を最大 10 回まで再試行します。ピアが尽きたときにだけそのモデルをマークし、次のルートへ進みます。OpenAI の `insufficient_quota` はプロバイダー全体を一度にマークします。そのアカウントで後に成功すれば、マークは外れます。
- **リストの順序は書かれたとおり**（ペースによる前後の移動を除く） — `auth_mode` ゲートはありません。サブスクリプションのルートは、その後ろに書かれた api_key のルートをそのまま保ち、同一プロバイダーの別ティアも辿られます（枯渇は `(provider, model)` 単位でマークされるため）。サブスクリプションから従量課金へこぼしたくなければ、その後ろに api_key のルートを書かないでください。
- **マルチアカウントバランシング** — 同一プロバイダーで複数のアカウントが有効なとき、アカウント選択はまず記録済みの束縛ウィンドウが 99 % に達しているアカウントを除外し、粘着中のセッション→アカウント対応が生き残りを指していればそれを再利用し、そうでなければ必要バーンレート — `残り % ÷ リセットまでの残り時間（時間）` を最もきつい束縛週次ウィンドウで取った値 — が最大のアカウント、つまりクォータを使い残すリスクが最も高いアカウントを選びます。同点なら最も長く選ばれていないアカウントです。

判断は構造化ログに残ります。リストに使えるルートが無かったときは、飛ばしたルートごとの理由 — `disabled` / `alias_unset` / `no_web_search` / `context_too_small` / `exhausted` / `error_rate` — を、429 か 400 を返すときは `warn` で、呼び出し側のモデルを送るときは `info` で出します。ペースで順が変わったときと、Long context のしきい値が動いたときも `info` で出します。

> **週次ドレインガードは存在しません。** 以前のビルドは、サブスクリプションプロバイダーの週次ウィンドウが線形ドレイン目標を超えると先回りで切り替えていました。それは無くなりました。サブスクリプションの振り先が止められるのは、スケジューラのスナップショットが使い切り — あるいはデフォルト 100 の `quotaSkipPct` 以上の使用 — を報告したときだけです。ペースはまだ開いているルートの順を変えるだけで、それ以外は上流の上限まで走り、実際に返ってきた 429 でローテーションします。

### ペルソナ

*ペルソナ*とは、ルーティングの後に routed な `/v1/messages` リクエストへ毎回追記される、名前付きのシステムプロンプト断片です。Claude Code 本体に手を入れずに、口調・役割・作業ルールを常時上乗せできます。

- **ライブラリ** — `Personas` はディスクエンベロープのトップレベル配列。各エントリは安定 uuid の `id`、表示用の `name`（一意でなくてよい）、本文の `prompt` を持ちます。新規インストールには小さなスターターライブラリが同梱されますが、既存環境はディスク上の既存内容を維持します。
- **アクティブ選択** — インストールごとに最大 1 つだけアクティブにできます。その uuid id はトップレベルの `ActivePersona` キーで、ディスクエンベロープでも `/api/config` のワイヤでも同じ場所にあります。`null` / 欠落 / 空文字は「ペルソナ無し」。プロジェクト別・セッション別のオーバーライドファイルはありません。
- **挿入方法** — アクティブペルソナの `prompt` を、`cache_control` を持つ最後の system ブロック（無ければ最後の文字列テキストブロック）に追記します。これによりペルソナはキャッシュプレフィクスの*内側*に収まり、追加のキャッシュブレークポイントを消費せず、リクエスト間でバイト単位の安定性が保たれます（Anthropic のプロンプトキャッシュが維持される）。`system` が文字列 / 未定義のときは結合、複数ブロックの配列のときはその場で更新します。
- **受け口による制限** — ペルソナ挿入が走るのは **`/v1/messages` だけ**、しかも routed なトラフィックだけです。passthrough の受け口や `passthrough` プロファイルに固定したトークンはルーティングを飛ばし、ペルソナも付きません。OpenAI 互換面と Gemini 面は肥大化した `system` フィールドをそもそも受け付けない（Codex は `Unsupported parameter: system` を返す）ため、リクエストを壊すよりはと挿入をスキップしています。`/v1/messages` 上の routed なリクエストは、どのルートで処理されたかにかかわらずアクティブペルソナを継承します — ルートが無く呼び出し側のモデルのまま出ていくリクエストも同じです。
- **サブエージェントとの相互作用** — ペルソナ挿入はサブエージェントタグを除去した*後*で走るので、サブエージェント呼び出しごとの system 内容を上書きせず、ペルソナと合成されます。

ライブラリ管理もアクティブペルソナの切り替えも **Settings → Personas**（`/settings/personas`）で行います。「ペルソナ無し」がデフォルトの no-op です。

再現精度の高いペルソナを書くための実践ガイド（構造パターン・アンチパターン列挙・思考プロセスの制御）は [docs/guides/persona-authoring.md](docs/guides/persona-authoring.md) を参照してください。

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

プロバイダごとに設定するトランスフォーマー項目はありません。導出されたチェーンは Providers ページの **Request shape** に読み取り専用で表示され、リクエストの挙動がおかしいときに最初に見るべき情報です。

### サブエージェントタグ

2 つ目の system ブロックの先頭にあるサブエージェントタグは、そのリクエストを **Subagent** レーンへ振り分けます：

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

意味を持つのは有無だけで、中身は無視されます。タグ付きのリクエストはそのシナリオの Subagent のリストで振り分けられ — サブエージェントに使わせるモデルは、プロンプトファイルごとではなくここに書きます — そのリストに使えるルートが無ければ Subagent の Default のリストへ落ち、Agent レーンへは行きません。Subagent の Default も空なら、呼び出し側のモデルのまま出ていきます。タグはリクエストログにも記録されるので、Activity でサブエージェントのトラフィックを見分けられます。タグは上流へ送る前に、パススルーを含むどちらのモードでも除去されるので、この目印がベンダーに届くことはありません。タグを読むのは Anthropic 形の `system` からなので、OpenAI 面と Gemini 面のリクエストは常に Agent レーンで振り分けられます。

`<CCR-SUBAGENT-MODEL>` はリネーム前の綴りで、既に書かれているプロンプトの中に生きているため、引き続き認識され除去されます。中身に古い `provider,model` の組を書いたままのタグも害はありません — その組が読まれないだけです。

## 🔀 OpenAI 互換・Gemini 互換の受け口

OpenAI SDK の呼び手（Codex CLI、Cline、OpenWebUI、Python / JS の `openai`、`curl`）も、Gemini SDK の呼び手も、あなたの**サブスクリプション枠**（Claude Max、ChatGPT Plus/Pro）を素のベンダーエンドポイントのように消費できます。呼び手から見えるのは通常のリクエスト / レスポンスですが、Rialto の裏では OAuth 認証済みのアカウントへ流れるので、コストは従量課金の API 請求ではなく月額サブスクリプションの内側に留まります。

### エンドポイント（OpenAI ワイヤ形式）

| メソッド | パス | 備考 |
|---|---|---|
| `GET`  | `/v1/models`             | 有効でルーティング可能なモデルを `{object:'list', data:[…]}` で返します。各 `id` は Rialto の正準形 `provider,model` なので、そのまま次の呼び出しに使い回せます。`owned_by` はプロバイダー名です。 |
| `POST` | `/v1/chat/completions`   | 標準の Chat Completions — ストリーム / 非ストリーム両対応。body の `model` には `/v1/models` の `provider,model` id を渡します。 |
| `POST` | `/v1/responses`          | OpenAI Responses API — ストリーム / 非ストリーム両対応。モデル指定は上と同じ。 |

この 3 パスの認証は **`Authorization: Bearer <発行済みアクセストークン>` のみ**です（`x-api-key` は Anthropic の規約なのでここでは拒否され、401 の body は OpenAI の `{error:{message,type,code}}` 形式に従います）。Anthropic 面（`/v1/messages`）は追加で `x-api-key` も読みますが、値はやはり発行済みアクセストークンでなければなりません。

### 例 — OpenAI Python SDK から Codex サブスクリプションを使う

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="rialto_your-access-token",   # Access tokens 画面で発行
)

# 1. ルーティング可能なモデルを列挙
for m in client.models.list().data:
    print(m.id, m.owned_by)
# → codex,gpt-5.5  (owned_by=codex)
# → claude-code,claude-sonnet-5  (owned_by=claude-code)
# ...

# 2. Chat Completions（Codex Plus/Pro サブスクリプション経由でルーティング）
res = client.chat.completions.create(
    model="codex,gpt-5.5",
    messages=[{"role": "user", "content": "reply pong"}],
)
print(res.choices[0].message.content)  # → pong
```

### 例 — OpenAI JS SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: process.env.RIALTO_ACCESS_TOKEN, // Access tokens 画面で発行
})

const stream = await client.chat.completions.create({
  model: 'codex,gpt-5.5',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

`base_url` / `baseURL` を上書きできるクライアントなら同じように動きます。

**これらの受け口で何が効くか。** フェイルオーバー、アカウントローテーション、`provider,model` 形式のモデル指定は常に効きます。シナリオ別ルーティングは、その受け口を `passthrough` から `routed` に切り替えて初めて効きます — そしてそのとき、クライアントが送るモデル名（`codex,gpt-5.5`、`gemini-2.5-pro`）は何も選びません。推論を求めるリクエスト（`reasoning_effort`・`reasoning`・`thinkingConfig`）は Think のリスト、長いリクエストは Long context のリスト、それ以外は Default のリストで、いずれも Agent レーンで振り分けられます。プロファイルを受け口どうしで共有すればリストも共有されるので、振り分けを変えたい受け口には専用のプロファイルを向けてください。ペルソナ挿入は効き**ません** — `/v1/messages` 専用です（上記「ペルソナ」参照）。

## 📊 ログ

ロガーは 1 つ（pino）で、HTTP リクエスト・ルーティング判断・上流呼び出し・サーバーイベントのすべてを書きます：

- **コンソール** — 常時、整形して出力。
- **ファイル** — `~/.rialto/logs/rialto-YYYY-MM-DD.log`。`LOG` が `true` のときだけ書かれます（デフォルトは `false`）。`LOG_MAX_MB`（デフォルト 10）を超えたファイルは `rialto-YYYY-MM-DD-N.log` に続きます。レベルは `LOG_LEVEL` で制御し、シークレット（`authorization`、`x-api-key`、トークン、cookie）は書き込み前にマスクされます。

ファイルは UI の **Activity → Logs** から閲覧できます。別建てのアプリケーションログはありません。

## 🌐 外部公開

トンネル越しに Rialto を公開する場合、`/api/*` と `/v1/*` は別扱いが必要です — 前者は Cloudflare Access の背後に、後者はエッジで Bypass して発行済みトークンだけを門にします。設定手順と、CLI クライアントがログイン画面で詰む失敗モードは [docs/guides/public-deployment.md](docs/guides/public-deployment.md) にまとめてあります。

**締め出されたとき**（Access の障害や設定ミス、`config.json` の退避、Postgres の停止）に頼る管理キーはありません — そして要りません。ホストへ SSH してポートを転送し、`http://localhost:3456` を開きます：

```shell
ssh -L 3456:localhost:3456 <host>
```

ホスト上から来たリクエストは管理ゲートを免除され、その判定は Access もデータベースも読みません。Docker ではポートをホストに公開したうえで（ループバックで十分）同じ手順です。この入口を塞ぐ設定は `RIALTO_TRUST_LOCAL=false` だけです。

## ⬆️ リネーム前ビルドからの移行

ホームディレクトリ、環境変数、データベース名、Docker イメージ、thinking signature のプレフィクスはいずれも Rialto へのリネームで変わり、旧ビルドのスロット / ルール / プリセットによるルーティングはチェーンとパススルーに統合されました。その後、シナリオ別のモデルのチェーンは、シナリオ別の「プロバイダー · ティア」のルートのリストになりました。v2.89.0 は寄り道をしていて — 要求モデルのティアで振り分け、`default` / `agent` のチェーンしか変換しなかった — このビルドはシナリオに戻します：初回起動時に、`db seed`（コンテナのエントリポイントが実行します）が各プロファイルの `default` / `think` / `longContext` のチェーンを両レーンとも、ティアエイリアスとルートへ、プロファイルごとに 1 回だけ変換します。v2.89.0 の Routing ページで編集したルートは引き継がれず、Web 検索と画像のリストは件数だけ記録され、変換されません。[docs/guides/migration-v3.md](docs/guides/migration-v3.md) を参照してください。

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
bun run test:e2e          # 起動済みの dev サーバーに対するブラウザテスト。
                          # :16175 が応答しないか chromium が無ければ自らスキップ
bun run browser:install   # test:e2e 用の playwright chromium
```

`bun test` と `bun run test` は**別のコマンド**です。CI（`.github/workflows/ci.yml`）は Commit Lint / Biome Check / Type Check / Test / Build の 5 ジョブを回します。

### チェック

```shell
bunx tsc --noEmit         # CI は `bunx tsc -b --noEmit` を実行します
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
| `bun run db:seed` | 冪等なシード — `live` ルーティングプロファイル（足すまではルート無し）。あわせて、各プロファイルの旧来のモデルのチェーンを、プロファイルごとに 1 回だけシナリオ別のルートへ変換します |
| `bun run db:seed:demo` | 全画面用の開発専用デモデータ。`-- --clean` で削除。[docs/guides/demo-data.md](docs/guides/demo-data.md) を参照 |
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

`v*.*.*` タグを打つと `ghcr.io/tkgstrator/rialto` が `linux/amd64` と `linux/arm64` 向けにビルド・公開されます（`.github/workflows/docker-publish.yml`）。下のスクリプトは同じイメージを手で作る経路です：

| スクリプト | 目的 |
|-----------|------|
| `bun run release` | `bun run build` の後、Docker イメージをビルドして GHCR へ push |
| `bun run release:docker` | Docker イメージのビルドと push のみ |

### アーキテクチャドキュメント

- [`docs/architecture/inbound-surfaces.md`](docs/architecture/inbound-surfaces.md) — 受け口レジストリと、そこから導出されるもの
- [`docs/architecture/inbound-parity.md`](docs/architecture/inbound-parity.md) — どの機能がどの受け口で効くか
- [`docs/architecture/routing.md`](docs/architecture/routing.md) — シナリオとプロバイダー · ティアによるルーティング：データモデル、ゲート、ペース、結果、Long context のしきい値、クォータスナップショット、モデルリリースの扱い
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — 起動 → リクエスト → upstream → 応答整形の通し動線
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — ルーティング判断と 429 ローテーションの拡大図
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — テストがどこにあり、何を担保しているか
- [`docs/guides/pwa.md`](docs/guides/pwa.md) — インストール型アプリ / PWA としての挙動

## ライセンス

MIT — `LICENSE` を参照。
