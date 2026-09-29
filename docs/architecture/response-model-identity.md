# 応答モデル ID の意味

Rialto には、似ているが意味の違う三つのモデル ID がある。

| 値 | 意味 |
| --- | --- |
| request model | クライアントがリクエストで指定した ID。ルーティングが有効なら、これは最終的な行き先を決めないことがある。 |
| selected model | Rialto がその試行で選んだ `provider,model`。429 などで failover した場合は、成功した後続候補を指す。 |
| response model | upstream が応答で返したモデル ID。プロバイダーの別名やバージョン付き ID のことがある。 |

## `/v1/models` はカタログである

`GET /v1/models` は現在有効でルーティング可能な `provider,model` の一覧を返す。これはクライアントが
選べる候補を知るためのカタログであり、特定の一回のリクエストを実際に処理した候補の証明ではない。

シナリオルーティング、アカウントローテーション、failover により、リクエストごとの成功候補は
カタログの複数候補のどれでもあり得る。

## 応答での扱い

成功した completion のレスポンス整形時に Rialto は次の規則を使う。

1. upstream が空でないモデル ID を返した場合、wire format のモデル値はそのまま保持する。
2. upstream がモデル ID を返さない場合だけ、成功した Rialto 候補の `provider,model` を wire format の
   モデル値として補う。
3. upstream 値と Rialto の選択値が異なっても、upstream 値を選択値で上書きしない。選択した候補は
   hidden upstream が実際に同じ名前で応答したことの証明ではないためである。

この規則は Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini GenerateContent の
JSON と SSE に適用される。SSE の補完はイベント単位で行うため、ストリーム全体をバッファリングせず最初の
トークンの到着を遅らせない。

`x-rialto-selected-model` ヘッダーは、成功した gateway 選択候補を常に `provider,model` で返す。
これはルーティングの provenance であり、upstream 自身が報告したモデル ID とは別の情報である。
