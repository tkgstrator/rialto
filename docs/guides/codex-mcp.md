# Codex MCP サーバー（`/codex`）

Rialto に登録した Codex サブスクリプションを、MCP サーバーとして HTTP で公開する。
Claude Code から Codex にセカンドオピニオンを求めたり、画像を作らせたりするためのもの。

`codex mcp-server`（stdio）を各マシンに設定するのと違い、URL とトークンを登録するだけで
Claude Code（CLI・Desktop とも）から使える。Codex の OAuth、アカウントのローテーション、
使用量の記録は Rialto が持っているものをそのまま使う。

## ツール

| ツール | 内容 |
| --- | --- |
| `ask` | Codex に質問する。レビュー、設計の批評、デバッグの相談など。`thread_id` を渡すと同じ会話を続けられる |
| `generate_image` | Codex の画像モデルで画像を作る。画像そのものと、15 分有効のダウンロード URL を返す |
| `status` | Codex アカウントごとの 5 時間枠・週枠の使用率とリセット時刻、使えるモデルの一覧 |

- **Codex 専用。** 呼び先は Codex のサブスクリプションプロバイダーに固定で、`/v1/responses` を
  routed にしていても他のプロバイダーへは振り替えない。Codex の答えとして返すものが、
  別のモデルの答えであってはいけないため。アカウント間のローテーションは行う。
- **Codex はファイルを見られない。** リポジトリを読んだりコマンドを実行したりはしない。
  レビューしてほしいコードや差分は、呼び出し側（Claude）がプロンプトに入れる。
  Codex に手元のリポジトリを直接触らせたいなら、従来どおりローカルの `codex mcp-server` を使う。
- `/v1/responses` と `/v1/images/generations` のパススルーで拒否しているターゲットは、MCP からも使えない。

## トークンとスコープ

MCP サーバーには、**`/codex` スコープを明示的に持つアクセストークン**でだけ接続できる。

- Access tokens 画面のエンドポイント選択で `/codex` を選ぶ。
- 「すべてのエンドポイント」（スコープなし）のトークンは `/codex` に入れない。`status` が運用者の
  Codex アカウントと残量を返すので、アプリやクライアント向けに出したトークンからは既定で見えないようにしている。
- `/codex` はスコープとしては `/v1/*` と独立している。`/codex` だけのトークンは `/v1/*` を呼べない。
  Claude Code 用にまとめるなら `/v1/messages` と `/codex` を選ぶ。
- `/codex` を使うのに `/v1/responses` や `/v1/images/generations` のスコープは要らない。

プラン付きトークンの場合:

- 1 日の上限に数えるのは `ask` と `generate_image` の呼び出し 1 回につき 1 回。接続時の `initialize` や
  `tools/list`、`status` は数えない。
- プランのモデルに含まれないモデルは断る。`/v1/*` のようにプランの既定モデルへ差し替えることはしない。

## Claude Code への登録

```sh
claude mcp add --transport http --scope user codex https://rialto.example.com/codex \
  --header "Authorization: Bearer <アクセストークン>"
```

- `--scope user` だと `~/.claude.json` に入り、どのプロジェクトからでも使える。Claude Code Desktop の
  Code タブも同じファイルを読むので、別に登録する必要はない。
- プロジェクトの `.mcp.json` にトークンを直接書かないこと（git に入る）。共有したいときは環境変数で渡す:
  `"headers": { "Authorization": "Bearer ${CODEX_MCP_TOKEN}" }`
- devcontainer の中の Claude Code は、`CLAUDE_CONFIG_DIR` がコンテナ内を指していればホストとは別の設定になる。
  中でも同じコマンドで登録する。
- Rialto と同じマシンからなら `http://localhost:3456/codex` に直接つないでもよい。トークンはこの場合も要る。

トークンが無効なときは 401、`/codex` スコープがないときは 403 を返す。401 には OAuth の案内
（`WWW-Authenticate` の `resource_metadata`）を付けていない。認可サーバーは無いので、クライアントを
OAuth のサインインに誘導しても成功しないため。ChatGPT や claude.ai のコネクタのように
OAuth しか受け付けないクライアントには、今のところ対応していない。

## 画像の保存

`generate_image` の結果には、画像そのものとダウンロード URL の両方が入る。

- 画像はモデルに見せるためのもの。モデルは見た画像をファイルに書き戻せない。
- 保存は URL から行う: `curl -fsSL -o out.png '<URL>'`
- URL は `/codex/files/<ランダムな鍵>`。鍵は 128 bit の乱数で、**URL を知っていれば誰でも取得できる**
  （curl のコマンドにトークンを書かせないため）。15 分で消え、キャッシュも検索エンジンへの登録もさせない。
- `include_image: false` にすると URL だけを返す（結果が小さくなる）。

## 公開

`/v1` と同じく、Cloudflare Access では守れない（MCP クライアントは対話ログインができない）。
`/codex` を Bypass にする（[public-deployment.md](public-deployment.md)）。

MCP サーバーを 1 つのホストにパスで集約している場合（`mcp.example.com/suumo`、`/local` など）は、
そのホストの Worker Route `mcp.example.com/codex*` に、Rialto へ転送するだけの Worker を置く。
Rialto 側のパスも `/codex` なので、ホスト名を差し替えるだけでよい。

```js
export default {
  async fetch(request) {
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    // ダウンロード URL を mcp.example.com 側で組み立てさせる。
    headers.set('x-forwarded-host', url.host)
    return fetch(new URL(url.pathname + url.search, 'https://rialto.example.com'), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual'
    })
  }
}
```

Worker からの転送も Rialto 側ホストの Access を通るので、そちらの `/codex` も Bypass にしておく。

## 仕組みのメモ

- Streamable HTTP のステートレスモード。`POST /codex` がリクエストごとに完結する。
  `GET` / `DELETE` は 405（開くストリームも、終わらせるセッションも無い）。
- `ask` は `/v1/responses` の処理をプロセス内で呼ぶ。ログには `surface = codex-mcp` として記録され、
  Activity では `/codex` と表示される。同じスレッドの呼び出しは 1 つのセッションにまとまる。
- スレッドの履歴は Rialto のメモリに 24 時間置く。Rialto を再起動すると消える。
- 返答や画像に数分かかっても接続が切れないよう、処理中は 15 秒ごとに通知（progress、
  またはクライアントが progress を求めていなければログ通知）を送る。Cloudflare は 100 秒、
  Bun は最大 255 秒、無通信の接続を切るため。
- クライアントが SDK の知らない新しいプロトコルバージョンを名乗った場合は、SDK の既定バージョンとして受け付ける。

## 動作確認

```sh
curl -s https://rialto.example.com/codex \
  -H 'Authorization: Bearer <アクセストークン>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
