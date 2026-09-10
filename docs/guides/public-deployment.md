# 外部公開（Cloudflare Tunnel + Access）

Rialto をトンネル越しに公開するときの設定。**`/api/*` と `/v1/*` は要件が違うので、
別々の Access アプリケーションにする**のが要点。

## なぜ2つに分けるのか

| 経路 | 呼び手 | 認証 |
|---|---|---|
| `/` `/api/*` | ブラウザの人間 | Cloudflare Access（メール等） |
| `/v1/*` | Claude Code / Codex CLI / Gemini CLI | Rialto の AccessToken **のみ** |

**`/v1/*` を Access で守ることはできない。** CLI クライアントは対話ログインができず、
サービストークン（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）ヘッダも送れない。
よってこの経路はエッジを **Bypass (Everyone)** で素通りさせ、**Rialto の AccessToken が
唯一の門**になる。

ここを間違えて `/v1/*` にも Access ポリシーを掛けると、Claude Code / Codex が全滅する。

```
Access app A:  rialto.example.com/       Allow (email)      → UI + /api/*
Access app B:  rialto.example.com/v1     Bypass (Everyone)  → Rialto の AccessToken
Access app C:  rialto.example.com/health Bypass (Everyone)  → 外形監視（任意）
```

パスの深い方（`/v1`）が先に評価されるよう、アプリの順序に注意する。

`/health` は管理ゲートの外にある監視用エンドポイントなので、外形監視を当てているなら
同様に Bypass しておく。覆ったままだと監視が Access のログインHTMLを掴んで常時赤になる。

### Allow (Everyone) と Bypass は別物

| | Everyone + Allow | Bypass |
|---|---|---|
| ログイン画面 | **出る** | 出ない |
| IdP 認証 | **必要** | 不要 |
| `Cf-Access-Jwt-Assertion` | 注入される | されない |

**「Everyone」は「誰でも通す」ではなく「認証さえ済めば誰でも許可する」。** 認証自体は必須のまま
なので、`/v1` を Everyone + Allow にすると CLI はログイン画面にリダイレクトされて詰む。
ここは Bypass でなければならない。

逆に UI 側（`/`）を Bypass にすると assertion が注入されなくなり、Rialto から見て
「Access が居ない」状態になる。`/api/*` を通れるのはホスト上からのリクエストだけになり、
リモートのブラウザは締め出される。

Bypass の条件は Everyone でなくてもよい。クライアントの出口IPが固定なら送信元IPで絞れる。
変動するなら Everyone とし、防御は Rialto の発行済みトークン（個別失効・面スコープ）に委ねる。

## 1. Access アプリを作る

`/` 用のアプリを作り、**Application Audience (AUD) Tag** を控える。これが `ACCESS_AUD` になる。
チームドメインは `<team>.cloudflareaccess.com`。

> **Policy ID と間違えないこと。** ポリシー一覧に出る `a26eca84-65d8-4b67-...` のような
> **ハイフン区切りUUID**は Policy ID であって AUD ではない。AUD は**64桁の16進数**（ハイフン無し）で、
> ポリシーではなく**アプリケーション**に属する。Policy ID を入れると署名は通っても audience 検証で落ち、
> 代わりに通す門も無いので**ブラウザから締め出される**（入り直し方は「締め出されたとき」）。
>
> 迷ったら、Access 経由で開いた状態で `GET /api/access-check/detect` を叩けば、
> そのリクエストの assertion から両方の値が読める。

**Destination にパスを付けないと、ホスト名全体が対象になる。** `llm.example.com` とだけ書いた
アプリは `/v1/*` も `/health` も覆う。次節の Bypass アプリを必ず併せて作ること。

## 2. Rialto に渡す

```
ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
ACCESS_AUD=<AUD tag>
```

**両方揃って初めて有効になる。** 片方だけでは Access 検証は一切行われない — 署名だけ検証して
audience を見ないと、**同じチームの別アプリのトークンで入れてしまう**ため、意図的に
「半端な設定は無効」にしてある。

設定後 `GET /api/identity` の `accessConfigured` が `true` になり、トンネル越しに開くと `mode` が
`cloudflare_access`、`email` に検証済みのアドレスが入る（ホスト上のブラウザから開くと `mode` は
`local` で、Access が効いているかはそこでは確かめられない）。

## 3. `/v1/*` 用のトークンを発行する

Access tokens で発行する。**平文は発行時の1回しか表示されない**（保存しているのは
sha256 のみ）。失くしたら再発行するしかない。

クライアント側:

```bash
export ANTHROPIC_BASE_URL=https://rialto.example.com
export ANTHROPIC_AUTH_TOKEN=rialto_xxxxxxxx
```

UI を開けない場合は、**ホスト上で**資格情報ヘッダ無しに API を叩いて発行できる（ホスト上からの
リクエストはローカル免除で `/api/*` を通る。この節の `curl` はすべてホスト上で実行する前提）:

```bash
curl -s -X POST http://localhost:3456/api/access-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"claude-code"}' | jq -r .plaintext
```

トークンには **面**（どのエンドポイントを叩けるか）と **ルーティングプロファイル**を
紐づけられる。CI のトークンだけ `cost-first` に固定する、といった運用ができる。

面は **複数指定できる**（`surfaces` は配列で、空なら全面）。1 つのクライアントが複数の面を
使うことは珍しくない — Codex は `/v1/responses` と `/v1/chat/completions` の両方を叩くので、
単一指定しかできなかった頃は「どちらかが 401 になる」か「面の指定を外す」かの二択だった。

```bash
curl -s -X POST http://localhost:3456/api/access-tokens \
  -H 'content-type: application/json' \
  -d '{"name":"codex","surfaces":["openai-responses","openai-chat"]}' | jq -r .plaintext
```

面の制限が掛かるのは**完了系のエンドポイントだけ**。`GET /v1/models` と
`POST /v1/messages/count_tokens` はカタログ読み取りで、課金も発生せずサーフェス
レジストリにも載っていないため、面を絞ったトークンでも通る。OpenAI SDK は最初に
モデル一覧を取りに行くので、ここを塞ぐと「`/v1/chat/completions` に絞る」が
「OpenAI SDK が使えない」と同義になってしまう。

### 漏れたトークンはローテートする（発行し直さない）

Access tokens のトークン行をクリックすると、そのトークンの詳細ページに入る。
**Rotate / Revoke / Delete はここにしか無い**。一覧に置いていた頃は、生きている資格情報が
並んだ表の全行に失効ボタンが載っていて、狙いを外した 1 クリックがクライアントを
401 で落とす — しかもクライアント側からはその原因を辿れない。

Rotate は**行を残したまま値だけ差し替える**:

| 変わるもの | 変わらないもの |
|---|---|
| `tokenHash` / `prefix`（新しい平文を一度だけ表示） | `id`・名前・面・プロファイル・有効期限 |
| `rotatedAt` | `requestCount`・利用額・この行を指す全 `RequestLog` |

`id` が変わらないので、Activity の帰属が切れない。発行し直すと同じマシンの履歴が
「CI」と「CI (old)」の 2 行に割れ、後から見て同一だと分かるのは覚えている人だけになる。

旧トークンは即座に無効になる。行のハッシュが消え、`resolveAccessToken` のホットパス
キャッシュも同時にクリアされるので、TTL（30 秒）の分だけ生き残ることもない。

```bash
curl -s -X POST http://localhost:3456/api/access-tokens/$ID/rotate | jq -r .plaintext
```

失効済み / 期限切れの行は **409 で拒否される**。新しい値を載せても `revokedAt` と
`expiresAt` はそのままなので、返しても最初のリクエストで死ぬ平文になる。この場合は
ローテートではなく新規発行が正しい。

Revoke は行を残して無効化し、Delete は行ごと消す。Delete が失効済みの行にしか出ないのは、
消した時点で過去のリクエストの帰属も一緒に失われるためで、アクセスの観点では何も変わらない
操作と引き換えに監査証跡だけを捨てることになる。

## 4. オリジンを直接叩けなくする

**Access はエッジでしか効かない。** オリジン（このプロセス）に直接到達できる経路が残っていると、
`Cf-Access-Jwt-Assertion` ヘッダを偽造されても検証は通らないものの、`Host` をループバック名にして
転送ヘッダを付けないリクエストは次節のローカル免除で `/api/*` を通ってしまう。cloudflared 経由のみで
到達するようにし、`HOST` を loopback に寄せるか、ファイアウォールで塞ぐ。

## ローカル免除は「peer が loopback か」では判定していない

`/api/*` の管理ゲートには、**Rialto が動いているマシン上のブラウザを免除する**経路がある
（`src/api/local-access.ts`）。自分のノート PC に自分でトークンを打たせる意味が無いためだが、
この判定は**この構成でこそ壊れやすい**: cloudflared は同じホストで動いて 127.0.0.1 に
プロキシするので、トンネルを立てた瞬間、公開インターネットからの**あらゆる**リクエストが
loopback から到着する。peer アドレスだけを信じる実装は、トンネルを設定した時点で管理 API を
世界に公開してしまう。

そのため 2 つの signal を **AND** で要求している:

| signal | 内容 |
|---|---|
| `Host` がループバック名 | マシン上のブラウザは `localhost:16175` を送る。トンネル経由のリクエストは cloudflared が公開ホスト名を保つので一致しない |
| 転送ヘッダが 1 つも無い | `cf-connecting-ip` / `cf-ray` / `cf-access-jwt-assertion` / `x-forwarded-*` / `x-real-ip` / `forwarded` のいずれかがあれば、そのリクエストはこのマシン発ではない |

免除を完全に切りたい場合は `RIALTO_TRUST_LOCAL=false`（プロセス環境変数。config envelope の
キーではない）。ローカルからのリクエストにも Access の assertion を要求するようになる。つまり
Access を設定していないまま切ると `/api/*` には何も届かなくなり（起動時に警告が出る）、
「締め出されたとき」の入り直し方も使えなくなる。

この判定が**防いでいないもの**: そのポートに TCP 接続を張り、任意のヘッダを立てられる何か。
loopback 上ではそれはマシン上のプロセスであり、設定ファイルを読んでトークンを取れる。
マシン外からなら、それはオリジンに直接到達できているということ — 本節が「やるな」と言っている
状態そのもので、ヘッダ検査では直せない。

## 管理用の共有シークレットは無い

`/api/*` を通れるのは次の 2 つだけで、`x-api-key` / `Authorization: Bearer` で送る管理用の
資格情報は存在しない。

| 門 | 条件 |
|---|---|
| ホスト上からのリクエスト | 前節のローカル免除（`Host` がループバック名 AND 転送ヘッダ無し）。`RIALTO_TRUST_LOCAL=false` で切れる |
| Cloudflare Access | `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` が両方あり、assertion の検証が通ること |

**以前あった envelope の `APIKEY`（bootstrap token / 緊急脱出用の管理キー）は削除した。**
Access を迂回できる `/api/*` のマスターキーで、`config.json`・バックアップ・シェル履歴のどこかから
読み取った者なら誰でも使えた。残していた理由の障害 — Access 側の障害で管理UIから締め出される、
Postgres が落ちて AccessToken を引けない（＝UIからトークンを発行できない）— には、秘密を要らない
入り直し方が既にある（「締め出されたとき」）。`config.json` に残った `APIKEY` は無視され、次の保存で
消える（`POST /api/config` が警告を出す）。環境変数の `APIKEY` も読まれない。EventSource のために
`/api/request-logs/events` だけが受けていた `?apikey=` クエリも無くなった。

`/v1/*` はエッジで Bypass にする以上、このミドルウェアが通すものが
**課金経路の前に立つ唯一の門**になる。そこにマスターキーを残すと、
「失効させると全クライアントが同時に切れる」「どのクライアントが焼いたか分からない」
という、発行済みトークンを導入した理由そのものが復活する。よって `/v1/*` は
**発行済み AccessToken のみ**。

結果として、**トークンを1本も発行していないインストールは `/v1/*` を通せない**。
これは意図した形で、「管理キーを持っている者なら誰でも通れる」より
「誰が呼んでよいかを決めるまで閉じている」を選んでいる。

## 締め出されたとき

Access の障害や設定ミス、`config.json` が壊れて退避された、Postgres が落ちた — どの場合も
**ホストへ SSH してポートを転送する**:

```bash
ssh -L 3456:localhost:3456 <host>
# 手元のブラウザで http://localhost:3456 を開く
```

転送されたリクエストは `Host` がループバック名で転送ヘッダも無いので、ホスト上からのリクエストとして
ローカル免除を通る。この判定は Access も DB も読まないので、両方が壊れていても効く。Docker では
ポートをホストに publish しておくこと（`127.0.0.1:3456:3456` のループバックだけで足りる）。
同じコマンドは Settings → Access の「If Access breaks」の行にも出ている。

UI を開かずにトークンを発行・ローテートしたいときは、ホスト上で `http://localhost:3456/api/...` を
資格情報ヘッダ無しに叩く（「3. `/v1/*` 用のトークンを発行する」の例）。

## サブスクリプションのサインイン（Claude / Codex）

OAuth のリダイレクト先は**ブラウザが動いているマシン**で解決される。公開運用では
サーバとブラウザが別マシンなので、ここが唯一つまずく所になる。

**Claude** — リモート（`localhost` / `127.0.0.1` 以外でUIを開いている）と判定した
initiate は、redirect_uri に Anthropic 自身の表示用コールバック
`https://platform.claude.com/oauth/code/callback` を使う。ブラウザは到達可能な
ページに着地し、そこに表示された `code#state` を Providers → Connect の貼り付け欄に
入れれば完了する。

**Codex** — OpenAI の OAuth クライアントは `http://localhost:1455/auth/callback`
だけを許可する。ポートもパスも差し替えられないので、同意画面は必ずブラウザ側の
`localhost:1455` へ飛ぶ。取れる手は3つ:

1. **Docker ホスト上のブラウザで開いている場合** — `compose.yaml` の
   `127.0.0.1:1455:1455` をそのまま残す。イメージは `CODEX_CALLBACK_HOST=0.0.0.0`
   でコンテナ内のリスナーを立てるので publish が効き、サインインは自動で完了する
   （ループバック bind のままだと Docker の publish プロキシからは見えない）。
   ホストのループバックにだけ publish しているので LAN には出ない。
2. **トンネル越し／別マシンから開いている場合** — 1455 はどう転送しても届かない。
   開けなかったページの URL をアドレスバーごとコピーし、Providers → Connect の
   貼り付け欄に入れる。`POST /api/oauth/manual-callback` が code+state を取り出して
   サーバ側で交換する。RFC 6749 が要求するのは redirect_uri が authorize 時と
   **同一文字列**であることだけで、サーバから到達できる必要はない。この構成なら
   `compose.yaml` の 1455 の publish は消してよい。
3. **OAuth を回さない** — どこかで `codex login` を済ませ、`~/.codex/auth.json` を
   Connect の「CLI からインポート」で読ませる。

貼り付けは急ぐこと: `state` はプロセスメモリに TTL 10 分で保持され、
サーバを再起動すると消える（`src/services/oauth-flow-service.ts`）。

## 現状の制限

- Access のグループ／ポリシー一覧の表示は未実装（Zero Trust API 連携が必要）。
