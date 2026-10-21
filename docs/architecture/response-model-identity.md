# 応答モデル ID の意味

Rialto には、似ているが意味の違う三つのモデル ID がある。

| 値 | 意味 |
| --- | --- |
| request model | クライアントがリクエストで指定した ID。ルーティングが有効なら、これは最終的な行き先を決めないことがある。 |
| selected model | Rialto がその試行で選んだ `provider,model`。429 などで failover した場合は、成功した後続候補を指す。 |
| response model | Rialto がクライアントに返す最終ルーティング先の `provider,model`。 |

## `/v1/models` はカタログである

`GET /v1/models` は現在有効でルーティング可能な `provider,model` の一覧を返す。これはクライアントが
選べる候補を知るためのカタログであり、特定の一回のリクエストを実際に処理した候補の証明ではない。

シナリオルーティング、アカウントローテーション、failover により、リクエストごとの成功候補は
カタログの複数候補のどれでもあり得る。

## 応答での扱い

成功した completion のレスポンス整形時に、Rialto は成功した invocation の `provider,model` を
wire format のモデル値として常に返す。upstream が応答にモデル ID、別名、版番号を含めていても、Rialto は
最終ルーティング先で上書きする。

これは Claude Code などのクライアントが、リクエストした alias ではなく Rialto がそのリクエストを実際に
送った先を記録・表示できるようにするためである。最初の候補が失敗した場合でも、成功した後続候補の
`provider,model` が返る。

この規則は Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini GenerateContent の
JSON と SSE に適用される。

Anthropic SSE では最初の `message_start` だけを書き換え、以後のバイト列はそのまま中継する。
大きな署名やツール入力のイベントが完成するまで、後続データを溜め込まない。
先行するデータのないレコード（コメントなど）と `ping` はそのまま返す。初期レコードが 64 KiB を超える場合、先行レコードが
32 件を超える場合、初期データを解釈できない場合、または途中で EOF になった場合は、元のバイト列を保持する。
この場合、本文のモデル値は書き換えない。ほかの SSE 形式では従来どおりイベント単位で書き換える。

`x-rialto-selected-model` ヘッダーも同じ `provider,model` を返す。これは wire format の `model` 値と
同じルーティング結果を、HTTP ヘッダーからも取得できるようにする補助情報である。
