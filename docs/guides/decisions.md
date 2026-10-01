# Decisions の設定と使い方（Jeff）

Decisions は、[Jeff](https://github.com/firelex/jeff) の System One API を管理画面から
試すための画面。状況と質問を送り、選択・確率・スコアを表示する。
**Decisions の回答で、本番リクエストのルーティングは変わらない。**

Rialto から Jeff へつなぐ実装例は2通りある。どちらも **Rialto が接続先をサーバー設定（`JEFF_URL`）だけで
決める**点は同じで、違うのは Jeff をどこで動かすか。

| | 実装例A: Macホスト上のJeff（MLX） | 実装例B: CPUサイドカー |
|---|---|---|
| Jeffを動かす場所 | Mac上のネイティブプロセス | 同じComposeの `jeff` サービス（任意profile `decisions`） |
| 推論 | MLX（Apple Silicon、Qwenモデルのみ） | PyTorch CPU（`JEFF_DEVICE=cpu`） |
| Rialtoの `JEFF_URL` | `http://host.docker.internal:8765` | `http://jeff:8765` |
| 追加でbuildするもの | なし（既にJeffがあればinstall・起動・モデル取得も不要） | `docker/jeff/Dockerfile` から約18.2GBのimage |
| ホスト公開・認証 | 不要（`JEFF_HOST` でコンテナから到達できるinterfaceにする） | 不要（`ports` なし・認証なし） |
| 実測・注意 | healthはReadyでもバックエンドを証明しない | 検証時の3秒制限ではタイムアウトした（現在の画面評価は5秒） |

どちらも、ローカルの信頼できる接続先でJeffの認証が無効なら、外部公開や `JEFF_API_KEY` は不要。
共通の環境変数・確認方法・画面の使い方は、実装例の後の「2.」以降にある。

## 1-A. 実装例A: Macホスト上のJeff（MLX）へ接続

Docker Desktop内のRialtoから、Macホスト上でJeffが待ち受けるポートへ接続する。
`host.docker.internal` はDocker Desktopからホストへ到達するための名前。
Jeffが `8765` 番ポートなら、Composeの `rialto` サービスに次を渡す
（利用者側の `compose.override.yaml` などに置く例。リポジトリの `compose.yaml` は既に
`JEFF_URL` と `JEFF_SHADOW_ENABLED` を空／`false` 既定で `rialto` へ渡している）:

```yaml
services:
  rialto:
    environment:
      # 既存のDATABASE_URL・REDIS_URLなどはそのまま残す
      JEFF_URL: http://host.docker.internal:8765
      JEFF_SHADOW_ENABLED: "false"
      # ローカルJeffが認証を無効にしていればJEFF_API_KEYは不要
```

起動環境の設定ファイルやシェルで同じ値を指定してもよい。反映のため、実際に動いているRialtoの
プロセスを再起動／再作成する。Compose版のRialtoなら、リポジトリのルートで:

```sh
docker compose up -d --force-recreate rialto
```

- **すでにJeffが動いているMacなら、追加のinstall／start／downloadは不要**。
  Jeffを新たに用意する場合だけ、後の「Jeffを新しく用意する場合」を参照する。
  CPUサイドカー（実装例B）のprofileは有効にしなくてよい。
- Rialto自体をdevcontainerで動かす場合も、そのコンテナから到達できる上記URLを
  起動環境へ渡す。再起動は、そのRialtoを起動している方法に合わせる。
- RialtoもJeffもMac上のネイティブプロセスなら、`http://127.0.0.1:<Jeffの待受ポート>` でよい。
  Rialtoコンテナ内の `localhost` はMacホストではなく、そのコンテナ自身。
- `/health` が `ready`・`authentication: false` なら、そのJeffへAPIキーなしで接続できる。
  `model` は例えば `jeff-qwen3.5-2b`。**healthはバックエンドの証明ではない**ので、
  この表示だけでMLX／Apple GPU／PyTorchと決めつけない。
- **インターネットへ公開する必要はない**。Tunnelや外向きドメインも不要。
  コンテナから既に到達できるJeffの待受設定は変えなくてよい。
- 新しいJeffをコンテナから読めるようにする場合、公式の `JEFF_HOST` で到達可能な
  ホストinterfaceを指定する（全interfaceの例は `JEFF_HOST=0.0.0.0`、既定は `127.0.0.1`）。
  `0.0.0.0` はLAN側にも待ち受けるため、必要なDocker側の通信だけを許し、
  意図しないLAN／外部アクセスをホストの設定で制限する。

設定反映後はDecisionsを開き、**Refresh** してReadyを確認する。
接続先Jeffのモデル、checkpoint、GPU設定は現在使っているものを維持する。

### Jeffを新しく用意する場合（MLX）

Jeffがまだ動いていないMacでだけ必要な手順。**Apple SiliconのGPUは、JeffのMLXバックエンドで使える。**
[公式READMEのApple Silicon向け手順](https://github.com/firelex/jeff)では、MLXは **Qwenモデルのみ対応**。
通常のDocker DesktopのLinuxコンテナへApple GPUをそのまま渡す構成ではないので、
Apple GPUを使うJeffはMac上でネイティブ実行し、Rialtoコンテナから接続する。

Jeffのリポジトリ内で依存関係を用意する:

```sh
uv sync --no-default-groups --extra mac
```

モデルの取得・checkpointの準備は公式READMEの起動手順に従う。
次は公式の0.8B用起動例に、コンテナから到達できる `JEFF_HOST=0.0.0.0` を加えた例。
待受interface・checkpointの場所・ポートは実際の構成に合わせる。

```sh
JEFF_HOST=0.0.0.0 JEFF_BACKEND=mlx JEFF_CHECKPOINT=checkpoints/jeff-0.8b \
  PORT=8765 uv run --no-default-groups --extra mac jeff-serve
```

これはRialto側のコマンドではない。両サービスがネイティブなら、Jeffを全interfaceで
待ち受けさせる必要はなくloopbackを使える。ホスト／LAN側のアクセス制限も確認する。
公式のM4 Maxベンチマーク中央値は0.8Bが約28ms、2Bが約60msだが、
CPUのスレッド数だけではGPU性能は分からず、別のMac Studioのチップで同じ性能を約束しない。
実際の入力でRialtoの画面評価の5秒タイムアウトに収まることを確認する。
公式にApple GPU向けDocker／Composeの起動手順はなく、ここで専用imageやGPU指定は用意しない。

## 1-B. 実装例B: CPUサイドカーを同じComposeで起動する

Macや既存のJeffを使わず、Rialtoと同じComposeにJeffを置く構成。`compose.yaml` の任意profile
**`decisions`** を有効にした時だけ起動する。通常の `docker compose up` ではJeffをbuild／起動せず、
`JEFF_URL` も空既定なので未構成のまま。Jeff公式に公開imageはないため、`docker/jeff/Dockerfile` が
上流のv1.1コミット `f0397f3785d93f73a01411d785d2ed026f53181d` からローカルimageをbuildする。

**注意: 検証したCPU環境では評価が3秒を超え、imageも約18.2GBあった**（下の実測値）。使用するホストで
容量と応答時間を確認してから選ぶ。検証用に起動したCPUサイドカーは停止済みで、モデルvolumeは残している。
次の手順を実行した場合にだけ起動する。

Rialtoの接続先は、Composeの `rialto` サービスに次のように渡す（起動環境の設定ファイルやシェルでも同じ値でよい）:

```yaml
services:
  rialto:
    environment:
      # 既存のDATABASE_URL・REDIS_URLなどはそのまま残す
      JEFF_URL: http://jeff:8765
      JEFF_SHADOW_ENABLED: "false"
      # サイドカーは認証なしなのでJEFF_API_KEYは不要
```

profileの有効化・サイドカーのbuild・Rialtoへの反映は、リポジトリのルートで次のように行う:

```sh
export COMPOSE_PROFILES=decisions
# JEFF_URL / JEFF_SHADOW_ENABLED は上のYAMLと同じ値。設定ファイル側に書いていれば不要
export JEFF_URL=http://jeff:8765
export JEFF_SHADOW_ENABLED=false

docker compose build jeff
docker compose up -d --wait --wait-timeout 900 jeff
# Jeffがhealthyになった後、環境変数をRialtoへ反映する
docker compose up -d --force-recreate rialto
```

- Rialtoのサービス名は `rialto`、Jeffは `jeff`。既定のComposeネットワークを共有し、
  **サービスDNSとコンテナ内ポート** `http://jeff:8765` で接続する。
  実装例Aの `host.docker.internal`（Macホスト）とは接続先が違う。
  独自networksでも、両サービスは少なくとも1つの共通ネットワークに参加する。
- サイドカーは公式の `JEFF_HOST=0.0.0.0`、`JEFF_BACKEND=pytorch`、`JEFF_DEVICE=cpu` を使用。
  **ホストへのports公開・認証・外部公開はない**。Tunnel、外向きドメイン、`JEFF_API_KEY` は不要。
- `mstrasser/Jeff-Qwen3.5-0.8B` を初回だけダウンロードし、named volume **`jeff_models`** に保存する。
  imageに重みを焼き込まず、volumeを削除しない限り再build後も再利用する。
- 初回はbuild・モデル取得・読込に時間がかかる。`/health` の `status == ready` を待ってhealthyになる。
  起動中のDecisionsは一時的にUnavailableでよい。healthyを待って **Refresh** する。
  Rialtoは接続失敗を自動再試行せず、Jeffへの `depends_on` もないため、通常起動は阻害しない。

### CPU資源・モデルの変更

`JEFF_CHECKPOINT`（保存先）と `JEFF_MODEL_REPO`（サイドカーentrypointが取得するHF repo）は
Compose overrideの `jeff.environment` で変更できる。モデルを変える場合は、古いdownload完了markerを
使わないよう **checkpointも別ディレクトリにする**。このサイドカーはCPU専用なので `JEFF_DEVICE=cpu` を維持する。
JeffにCPUスレッド数の専用環境変数はない。Docker DesktopのCPU割当やComposeの `cpus`・`mem_limit` で資源を調整する。

[Jeffの公式README](https://github.com/firelex/jeff)には、PyTorchのCPU導入として
Jeffのリポジトリ内での `uv sync --no-default-groups` が記載されている。
このリポジトリの `docker/jeff/` はその手順をコンテナ化したもので、独自の公式imageではない。
公式のCPU（32スレッド）ベンチマークで0.8Bの中央値は約463msだが、環境・入力によって変わる。
公表の1.7GBは16-bitの**重みサイズ**であり、必要な総RAM容量ではない。

### 実測値（実装例B・このリポジトリの検証環境のみ）

**linux/arm64・20スレッドのCPU・Jeff v1.1・Qwen3.5-0.8B・`JEFF_DEVICE=cpu`** の実測値。
実装例Aのホスト上Jeffや他の環境についての保証値ではない。

| 項目 | 測定値 |
|---|---|
| imageサイズ | 約18.2GB（上流lockfileが `torch 2.14.0+cu130` とnvidia系パッケージを含む。`cuda_available` は `False`） |
| モデルvolume | 約1.7GB |
| 起動 | build後、モデル取得・読込を含め約53秒でhealthy |
| 常駐メモリ | 約4.2GiB（`docker stats`） |
| 画面と同じ評価（1問・2択） | 約3.3〜4.2秒（8回） |
| 同じ評価を当時のRialtoと同じ3秒制限でComposeネットワーク越しに実行 | **3秒でタイムアウト** |

**このCPU環境ではhealthがReadyでも、検証時の3秒制限では評価が失敗した。** 公式の463msは
別のCPUでの値で、ここでは再現していない。現在の画面評価は5秒制限で、測定済みの3.3〜4.2秒は
その範囲内だが、CPUサイドカーを5秒制限で再検証した結果ではない。CPUで使うなら実ホストで
同じ評価時間を測り、収まらなければ実装例AのMacネイティブMLX、より速いCPU、または公式のCUDA対応環境を検討する。
Rialtoにタイムアウト変更設定はまだない。CPU推論自体は動くが、約18.2GBのサイドカーimageは
CPU専用wheelへ選び直した軽量imageではないので、ディスク容量も確保する。

### 接続先API

どの構成でもRialtoから、次の2つに到達できる必要がある。

| Jeff の経路 | 必要な動作 |
|---|---|
| `GET /health` | JSON で `status`（`ready` または `loading`）と空でない `model` を返す |
| `POST /v1/systemone` | `state`・`model`・`questions` を受け取り、回答と使用トークン数を返す |

healthの例（モデル名は実際にロードしたもの）:

```json
{"status":"ready","model":"jeff-qwen3.5-2b","authentication":false}
```

画面が送る `model` は **`jeff-latest` 固定**。healthに表示される実モデル名とは別。
Rialtoにモデル選択や `JEFF_MODEL` の設定はない。ProvidersのAPIキーやCodex MCP設定はこのサービスの代わりにならない。

## 2. Rialto サーバーの環境変数を設定する

ブラウザの設定ではなく、**Rialtoを動かしているプロセスの起動環境**に設定する。

| 環境変数 | 必須／既定値 | 内容 |
|---|---|---|
| `JEFF_URL` | 必須。既定URLなし | 到達できるJeffのベースURL。未設定・空文字では未構成になる |
| `JEFF_API_KEY` | 任意。既定キーなし | 評価の `Authorization: Bearer …`。Jeffが認証を要求する構成でだけ、そのキーを指定する |
| `JEFF_SHADOW_ENABLED` | 任意。既定OFF | 値が厳密に `true` の場合だけ本番サブエージェントのshadow観測を有効化。画面だけなら不要 |

`JEFF_URL` は実装例ごとに次の値になる（`JEFF_SHADOW_ENABLED` は共通）。

| 実装例 | `JEFF_URL` |
|---|---|
| A: Macホスト上のJeff（MLX） | `http://host.docker.internal:8765` |
| B: CPUサイドカー | `http://jeff:8765` |
| RialtoもJeffもホストのネイティブプロセス | `http://127.0.0.1:<Jeffの待受ポート>` |

環境変数ファイルで設定する場合の形:

```dotenv
# 実装例A（実装例Bなら http://jeff:8765）
JEFF_URL=http://host.docker.internal:8765
JEFF_SHADOW_ENABLED=false
# 認証なしのローカルJeffではJEFF_API_KEYは不要
```

別ホスト・外部サービスへの接続も任意で可能だが、必要な場合だけ到達可能なURLを設定する。
Bearer認証を要求するJeffでだけキーを設定する。Composeでキーも使う場合は、利用者のoverrideなどで
`rialto.environment` へ明示的に渡す。外部接続・認証はDecisions自体の必須条件ではない。

URL・キーの前後の空白は取り除かれる。shadowの `TRUE`、`1`、空白付き `true ` は有効化にならない。

### URLとコンテナの注意点

- `JEFF_URL` は `http://`／`https://`。埋め込み認証、query、fragment、`file://` などは拒否される。
- `/health` と `/v1/systemone` は **URLのルートから**解決される。
  `https://example.com/jeff/` でも `/jeff/health` にはならず、サブパス公開ならルート経路への転送が必要。
- コンテナ内の `localhost` はそのコンテナ自身。別コンテナは共通ネットワークのサービス名、
  MacホストのJeffはDocker Desktopの `host.docker.internal` を使う。別のDocker／OSの利用可否は構成による。
- 接続先はサーバー設定だけで決まり、画面や評価APIのリクエストからURLを指定できない。
- **healthには `JEFF_API_KEY` を送らない。** `/health` 自体をBearer必須にすると、正しいキーでもReadyにならない。
- **healthは3秒、画面からの評価は5秒タイムアウト**。shadow観測の評価は従来どおり3秒。
  リダイレクトは追跡しない。最終到達先URLと実際の応答時間を確認する。
  タイムアウトを変更する環境変数はない。
- Jeffは同時評価が1本だけで、重なると **HTTP 529**（`Retry-After: 1`、queueなし）を返す。
  そのため **Rialtoが評価を1件ずつ順番待ち（到着順）にして送る**。サブエージェントのshadowと画面が重なっても、
  Jeffには同時に1件しか届かず、通常は529にならない。
  - 評価の5秒タイムアウトは **自分の番が来てから**数える。順番待ちの時間は含めない。
  - 順番を待つ上限は、画面からの評価が **約15秒**、shadow観測が **約3秒**。待ち行列は **8件まで**で、
    超える／待ち切れない場合は `Jeff is busy with other evaluations.`（画面は502）で失敗する。shadowは
    待たずに諦めて `unavailable` を記録するだけで、本番リクエストを待たせない。
  - Rialtoを経由しない呼び出しなどでJeffが529を返した場合は、`Retry-After` に従って **1回だけ再試行**する
    （待つ上限の範囲内）。それでも529なら失敗として返す。
  - 順番待ちはRialtoの **1プロセス内**だけ。Rialtoを複数台動かす場合、台をまたいだ直列化はしない。

### 反映と秘密情報

起動環境を変えたら、実際のRialtoプロセスを再起動／再作成する。別シェルの `export` だけでは
既に稼働中のプロセスは変わらない。すでに動いているJeff（実装例A）なら、Jeff自体の再起動は不要。
Jeffの設定を変更した場合だけ、その変更をJeffへ反映する。

認証を使う構成では、キーはサーバーの秘密情報管理に置き、コミットしない。キーは評価時だけ
RialtoからJeffへ送り、ブラウザへ返さない。認証なしのローカル構成ではキー管理は不要。
ただし **状況・質問・選択肢は接続先Jeffに送る**ので、そのサービスに扱わせてよい内容で試す。

## 3. 接続状態を確認する

Decisionsを開くと、管理API `GET /api/decisions/status` がJeffの `/health` を確認する。
**Refresh** でも再確認できる。`ready` でのみRun decisionを実行でき、`loading` は構成済みでもReadyではない。

開発サーバーが例として `16175` 番ポートなら、Rialtoと同じホストから確認できる:

```sh
curl -fsS http://127.0.0.1:16175/api/decisions/status
```

正常時の管理APIの例:

```json
{
  "configured": true,
  "ready": true,
  "shadowEnabled": false,
  "model": "jeff-qwen3.5-2b",
  "error": null
}
```

`/api/decisions/*` は管理ゲート内。これは **ブラウザ → Rialto の管理アクセス**の話であり、
**Rialto → ローカルJeffに認証や外部公開を要求するものではない**。
ホスト上のブラウザからはローカル免除を使える。Rialtoの管理画面をリモートへ公開する場合は
Cloudflare Accessが必要で、`/v1/*` 用のアクセストークンで管理権限を代用しない。
その任意の構成は[外部公開の設定](public-deployment.md)を参照。
Rialtoは `/v1/systemone` をLLMクライアント向けの受け口として公開しない。

## 4. 画面で試す

1. Decision serviceが **Ready** であることを確認する。
2. **Situation (English)** に状況を書く（空欄不可、最大8,000文字）。
3. **Question type** を選び、**Question (English)** に質問を書く（空欄不可、最大500文字）。
4. `choice`／`score` では選択肢・尺度を書く（各項目は空欄不可、最大500文字）。
5. **Run decision** を押し、Resultの回答・確率・モデル名・入力トークン数を確認する。

| 種類 | 画面での入力 | 結果 |
|---|---|---|
| `choice` | 2〜26個の選択肢 | 選んだ項目、confidence、項目ごとの確率 |
| `noul` | true／falseで判断する質問。選択肢欄は不要 | `noul` の百分率 |
| `score` | 2〜10個の尺度 | score、尺度ごとの確率 |

UIの表示言語にかかわらず **英語で入力する**前提。翻訳せずそのまま送る。
APIのchoiceは254項目までだが画面は26項目。choiceからscoreへ切り替えるなら10個以下にする。
画面は `POST /api/decisions/evaluate` へ以下を送り、サーバーが固定のJeff `/v1/systemone` へ中継する。
APIは質問1〜4件を受け付けるが、画面は `task` の1件だけ。

```json
{
  "state": "Review a change that adds retries to an HTTP client.",
  "model": "jeff-latest",
  "questions": {
    "task": {
      "type": "choice",
      "instructions": "Which option best describes the task?",
      "criteria": {
        "1": "Simple, single-step work",
        "2": "Complex, multi-step reasoning or implementation"
      }
    }
  }
}
```

## 接続・実行できないとき

| 状態／エラー | 確認すること |
|---|---|
| 未構成（`configured: false`） | 実際のRialto起動環境に空でない `JEFF_URL` があるか |
| 構成済みだが未準備（`ready: false`、エラーなし） | healthがloadingのままでないか。ロード後にRefresh |
| `Jeff URL is invalid.` | URL形式、スキーム、埋め込み認証、query・fragment |
| `Jeff returned HTTP …` | healthの認証制限、評価用キー、経路の公開方法 |
| `Jeff is unavailable or timed out.` | 到達性、コンテナ内localhost、DNS／ポート、healthは3秒・画面評価は5秒以内の応答、リダイレクト |
| `Jeff returned an invalid health response.` | healthにready/loadingと空でないmodelがあるか |
| `Jeff returned an invalid response.` | 評価応答のmodel・answers・usageと質問種類に対応した形 |
| 管理APIの401 | Rialtoの管理認証。Jeffのキーとは別 |
| 評価APIの400 | 空欄、文字数、種類・尺度数などの入力検証 |
| 評価APIの502 | 未構成、到達失敗、上流HTTPエラー、応答形式不一致 |
| `Jeff returned HTTP 529.` | Rialto以外からも同じJeffへ評価が届いている。再試行1回でも529なら、少し待って再実行 |
| `Jeff is busy with other evaluations.` | 順番待ちの上限（画面約15秒・shadow約3秒、8件）を超えた。評価の頻度か、Jeffの処理速度を確認 |

Runが無効ならReady・入力や選択肢の空欄を確認する。設定後も未構成なら、
環境変数を設定した対象が実際のRialtoプロセスであるか、再起動したかを確認する。

## 任意: 本番サブエージェントのshadow観測

画面だけなら `JEFF_SHADOW_ENABLED` は **OFFでよい**。`true` はタグ付き本番サブエージェントの
判断結果を裏で観測する機能で、Run decisionとは別経路。**どちらもルーティングは変更しない**。

- `<RIALTO-SUBAGENT-MODEL>` と旧綴り `<CCR-SUBAGENT-MODEL>` が対象。
- 最新userターンから取り出せる、最大2,000文字のプレーンテキスト指示だけ送る。
  空、長すぎる指示、ツール／添付／混在、非ASCII、対象の英語タスク語がないものは除外。
  言語検出器ではなく、通過しても英語とは保証しない。
- 単純〜複雑のスコアを観測する。使えるprimary／fallbackのモデルと記録済みReasoning Effortから
  仮の適切な組み合わせも観測する。effort未確認ならvendor defaultのみで、組み合わせが
  2〜26件にならなければモデル／effort推定を省略してスコアだけ観測する。
- 上流呼び出しを待たせず非同期で実行。Jeffが使えなくても既存ルートで続ける。
  scenario、provider、model、送信effortや呼び手の明示effortは変更しない。
- `[shadow] subagent evaluation` の構造化ログにスコア、仮のモデル／effort、failover前primary、
  confidence、トークン数などを記録する。ファイルに残すなら `LOG=true` またはSettings → Logging。
  生の指示、過去の会話、system、ツール入力はログに残さないが、対象の指示はJeffへ送る。
- 通常ユーザーのリクエストはshadowへ送らず翻訳もしない。Claude Code自身の表示言語設定とは別で、
  Rialtoは内部推論の言語を強制しない。

## 実装の参照先

- `src/services/jeff-client.ts`: 環境変数、固定経路、health、Bearer、healthの3秒／画面評価の5秒タイムアウト、評価の順番待ち（1件ずつ・529の1回再試行）
- `src/api/decisions/route.ts`: 管理APIと400／502
- `src/schemas/api/decisions.ts`: 入力・回答の検証
- `src/components/rialto/decisions/DecisionsScreen.tsx`: 入力上限とjeff-latest
- `src/services/subagent-shadow-evaluation.ts`: shadow観測とログ
