# テスト責務マップ

## 目的

テストがどこにあり、何を担保しているかを一覧にする。「この変更でどのスイートが動くか」と
「この挙動を守っているテストはどれか」の両方を引けるようにするのが狙い。

`__tests__/` は `src/` のツリーをミラーする。ミラーが崩れているところ（`__tests__/lib` が
`src/lib` と `src/components/rialto` の両方を見ている等）は、その旨を下の表に書いてある。

## 3 つのコマンドは別物

```bash
bun test               # フルスイート
bun run test           # __tests__/lib __tests__/db __tests__/preset だけ
bun run test:providers # __tests__/providers だけ
```

`bun test` と `bun run test` は**同じコマンドではない**。CI は Build / Type Check / Test の
3 ゲートを回す。

## プリロード（`__tests__/setup.ts`）

`bunfig.toml` の `preload` により、`bun test` は**呼び出し方によらず**必ずこれを先に読む。
IDE のテストランナーやアドホックな `bun test <path>` も含む。防いでいる汚染は 2 つ:

| 汚染 | 対処 |
|---|---|
| `HOME_DIR` / `CONFIG_FILE` が `os.homedir()` から算出され、テストが開発者の実 `~/.rialto/config.json` を消しうる | `RIALTO_HOME_DIR` を tmp 配下に向ける。bun では `os.homedir()` が `$HOME` ではなく `/etc/passwd` を読むので、`$HOME` の上書きでは間に合わない |
| DB テストが `DATABASE_URL` の指す先を TRUNCATE する | `TEST_DATABASE_URL` へ差し替える。未設定なら `DATABASE_URL` を**削除**して DB スイートを skip させる（開発 DB を truncate するより skip の方がよい） |

さらに 2 つの防御がある: `TEST_DATABASE_URL === DATABASE_URL` なら throw、DB 名に `test` を
含まなければ throw。タイプミスで実 DB を飛ばせないようにするため。

## カバレッジマップ

### `__tests__/lib` — 純関数とフロントエンドのロジック

DB もネットワークも要らないユニットテスト。`bun run test` の対象。

| ファイル | 担保しているもの |
|---|---|
| `configEnvelopeSchema.test.ts` | `ConfigEnvelopeSchema` の受理／拒否（特に `API_TIMEOUT_MS` の coercion） |
| `config-salvage.test.ts` | 壊れた `config.json` から `Personas` を救い出す経路（`APIKEY` はもう救わない）と、資格情報を決して生成しないこと |
| `cloudflare-access.test.ts` | Access assertion の検証（署名 + audience） |
| `long-context-beta.test.ts` | `context-1m-*` beta ヘッダの取り回し |
| `message-content.test.ts` | メッセージ本文の正規化 |
| `models-build-rows.test.ts` | Providers 画面のモデル行の組み立て |
| `passthrough-denial.test.ts` | 面の `deniedTargets`（`passthroughDenial`）。一覧にある target は拒否し、一覧に無い target・空の一覧・面レジストリ外のパス・空の target は拒否しないこと |
| `persona-clear.test.ts` | 「ペルソナ無し」への戻し方（トップレベル `ActivePersona` の null / 空文字 / 欠落） |
| `provider-routable.test.ts` | `Provider.enabled` を Plan のモデルピッカー（`enabledTargets`）が絞る集合と Providers 画面の表示が一致すること |
| `thinking-signature-filter.test.ts` | `rialto_` プレフィクスの thinking signature 濾過 |
| `update-check.test.ts` | 更新チェック: バージョン比較（`v` 付きタグ・prerelease・読めないタグ）と、取得失敗を「最新です」に畳まないこと、成功だけをキャッシュすること |
| `rialto/format.test.ts` | 表示フォーマッタ（金額の有効数字など） |
| `rialto/effort-sort.test.ts` | Activity の Effort 列の並び順。アルファベット順ではなく `SupportedEffortSchema` の段階（none < minimal < low < medium < high < xhigh < max < ultra）で並べ、記録の無い行と未知の文字列は順位を持たず末尾に回ること |
| `rialto/provider-draft.test.ts` | プロバイダ詳細の Edit → Save が書くもの。手で元に戻した変更は何も書かないこと、プロバイダ・モデルのスイッチとキーは読み込んだ行を土台にした 1 回の upsert に載り、effort は変わったものだけが個別の書き込みになること（upsert には載せない）。Auto の effort は下書きに残り、空のキーは保存済みのキーを消すこと |
| `rialto/provider-account-draft.test.ts` | アカウント単位の利用フラグのドラフト。認証情報を変えずに表示へ反映し、変更された既存 id だけを保存すること、手で戻した変更は no-op、モデルだけの保存は古いアカウント一覧を送り直さないこと、最後の有効アカウントも OFF にできること |
| `rialto/account-extras.test.ts` | アカウント行の付帯情報（API 換算の使用量と Codex のバンク済みリセット）をアカウント id で引けること、欠けた読み取りを null のまま残すこと、割安度と失効日のフォーマッタ |
| `rialto/redact-tool-arguments.test.ts` | `REDACT_TOOL_ARGUMENTS` の除去処理 |
| `rialto/settings/access-config.test.ts`<br/>`rialto/settings/access-tokens.test.ts`<br/>`rialto/settings/envelope.test.ts` | Settings 画面の各フォームのロジック |
| `rialto/settings-content/persona.test.ts` | Settings のサブ画面のロジック |
| `rialto/custom-form.test.ts` | Custom プロバイダのフォームが送る前に決めること。触っていない欄は間違い扱いにしない（空のフォームは問題なし・ボタンだけ無効）、名前は共有ルールどおり（長さ・文字種・予約語）で既存名とは大文字小文字を無視して `taken`、Base URL は http(s) 以外・認証情報つき・クエリつきを refuse、プレビューのアドレスは保存されるものと同じ、手入力のモデル ID は空・空白入り・重複を refuse（大文字小文字は別 ID）。レールの Custom カードはカタログに 1 回だけ足されること |

### `__tests__/db` — DB を張った統合テスト

`TEST_DATABASE_URL` が無ければ丸ごと skip する。`bun run test` の対象。

| ファイル | 担保しているもの |
|---|---|
| `config-service.test.ts` | `applyUiConfig` / `composeUiConfig` の往復整合、モデル削除が警告なしで外れること、Providers だけの保存が他に触らないこと、退役キー（`APIKEY` / `Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK`）を警告付きで捨て・ディスクから剥がし、`GET /api/config` にも出さないこと、トップレベル `ActivePersona` の往復、永続化、無効なプロバイダのモデルがルーティングの候補（registry）に入らないこと |
| `upsert-provider.test.ts` | Provider の upsert（重複名・モデル差分）。1 プロバイダの編集が他のプロバイダの SubAccount を消さないこと、CRUD 経路のモデル削除が残りのモデルを保つこと、プロバイダ削除がそのモデルを一緒に消して兄弟に触れないこと、存在しないプロバイダの削除は拒否 |
| `model-api-styles.test.ts` | `POST /api/providers` の `modelApiStyles`（`Model.apiStyle`）。載せたモデルはその値を保存し、provider 自身の style と同じ値は null、フィールドが**無い**保存（キーのローテーション、設定インポート）は既存の上書きを一切変えず、**ある**保存は既存の行で載っていないものを provider の style に戻す（空のマップも全部戻す）。同じ保存で作った行は名前由来の既定（codex 系）を保ち、マップが名指せば上書きできる。provider に無い名前は警告つきで無視、値が変わった行だけテスト結果を `unknown` に戻す、subscription provider は無視する。保存の後に `getLlmsContext()` がモデル別 chain を持つこと・次の保存で消えること（再起動不要）、Base URL が `/responses` でも保存され同じ chain になること |
| `custom-provider.test.ts` | Custom プロバイダ（[custom-provider.md](../guides/custom-provider.md)）。`createCustomProvider` が入力した Base URL と形式から endpoint を導き（3 形式 × tail）、api_key・無効・モデルは全部 OFF・価格と context window は null で保存すること。一覧が取れれば `found`、取れなくても provider は作られ `unavailable` と理由が返る。名前の重複は大文字小文字を無視して拒否し、拒否の前に相手の endpoint を叩かない（ビルトインの行と同名も同じ）。作成後は、形式が鍵の差し替えなど形式に触れない保存を越えて残り、運用者が 3 形式の間で動かせて、`gemini` は保存できないこと。手入力のモデルは ON で入り、一覧が空でも使えること。ON にすると形式に応じた chain で registry に載る。モデル同期は custom を `skipped` として報告し、誰にも問い合わせず行を変えないこと。同名のビルトイン vendor 行は同梱の価格表で値付けされたまま、custom 側の同名モデル（`gpt-4o`）は null のままであること。provider の Test は同じ一覧取得で（Claude 形式は `x-api-key`、OpenAI 形式は Bearer）、拒否されれば理由つきで失敗すること |
| `disabled-targets.test.ts` | 無効な Provider / Model がどの経路からも送られないこと — registry が有効なものだけを持つので `provider,model` の名指しも `resolveInvocationForModel` が拒否すること、bare 名が無効なプロバイダ・無効なモデルだけに居れば何にも解決しないこと、サブスクリプションのアカウントプールが無効なプロバイダを無視すること |
| `account-usage-service.test.ts` | アカウントごとの API 換算使用量。いまの週次窓の開始（リセット時刻から窓の長さを引く。Codex は上流の窓の長さを使い、リセットが過ぎていればそこから新しい窓、読めなければ直近 7 日）、サブスクのモデルを同名の有料モデルの価格で換算すること、「価格不明」（null）と「トラフィック無し」（0）を分けること、価格の無いモデルが価格の付いた分を消さないこと、割安度は額と月額の両方が要ること、各アカウントが自分の行しか見ないこと |
| `access-token-service.test.ts` | トークンの発行・解決・失効。保存は sha256 のみ |
| `usage-window-service.test.ts` | 利用枠（時計は `setSystemTime`）。最初のリクエストで両方の枠が開き以後は数えるだけ、埋まった枠はリセットまで断り拒否は数えない、5 時間の枠がリセットしても 7 日の枠は数え続け 7 日で戻ること、両方埋まれば遅いリセットを名指すこと、金額はまたいだ呼び出しは通し次を断ること・開いている枠にだけ足すこと・Cost 列と同じ価格で付けること、新しいトークンへの同時リクエストとリセットの瞬間の同時リクエストがちょうど上限だけ通ること、1 本と全体のリセット |
| `inbound-surface-service.test.ts` | 面ごとの `deniedTargets` の読み書き。行が無い面は何も拒否しない、Gemini の面が `model:action` のパスから引けること、レジストリに無いパスは面に解決されないこと、書き込みがキャッシュ越しのホットパスに即座に効くこと・戻せること、未知の面 id は書かずに拒否 |
| `overview-service.test.ts` | Overview 画面の集計クエリ。加えて quota 行にアカウントの API 換算使用量が載ること、failover フィードが 429 と拒否された資格情報を新しい順に出し、重みの行を出さないこと |
| `storage-service.test.ts` | ストレージ使用量の集計 |
| `helpers.ts` | DB 初期化／クリーンアップ、DB 利用可否ゲート |

### `__tests__/api` — HTTP 契約

| ファイル | 担保しているもの |
|---|---|
| `custom-provider-schema.test.ts` | `POST /api/providers/custom` の request / response スキーマ。形式は `anthropic` / `openai_chat` / `openai_responses` の 3 つだけで `gemini` は拒否、auth mode は指定できず常に api_key。名前と Base URL の問題は issue の `message` に問題コード（`empty` / `too_long` / `charset` / `reserved` / `invalid_base_url`）で載り、フォームがそれを自分の文言に写す。API キーは必須、プライベート / ループバックのアドレスは許可。`warnings` は常にあり、空でもその配列を返す |
| `health.test.ts` | `/health` が管理ゲート（`adminAuth`）の外にあること、db / redis の両チェックを報告すること、`summarizeHealth` の切り分け（必須依存の失敗だけが 503。redis 落ちは degraded だが 200）、Redis プローブが未設定なら `skip`・到達不能なら hang せず `fail` |
| `local-access.test.ts` | ローカルブラウザ免除の判定（トンネル背後で常に loopback に見える問題込み） |
| `openai-bearer-auth.test.ts` | OpenAI 面が Bearer のみを受けること |
| `usage-windows.test.ts` | プランの利用枠の `/v1` ゲート。カタログ（`/v1/models`・`count_tokens`）は数えず、補完は上限まで通して次を面の封筒の 429（`usage_limit_exceeded`、`Retry-After` はリセットまで、メッセージにリセット時刻）で断ること、金額の上限でも断ること、プランなし・上限なしのトークンは数えないこと。管理 API の枠の読み出し、トークン 1 本のリセット（404 も）と全トークンのリセット |
| `google-surface-auth.test.ts` | Gemini 面の `x-goog-api-key` / `?key=` |
| `request-log-events-auth.test.ts` | `/api/request-logs/events` がもう `?apikey=` を受けないこと — それを付けたリモートのリクエストは 401、ホスト上からのリクエストは通る |
| `error-shape.test.ts` | 3 種のエラー封筒の出し分け |
| `upstream-error.test.ts` | `PROVIDER_ERR_RE` の逆パースと verbatim 転送。effort 拒否の 400 の事後補正（`bestSupportedLevel` は `max` を除いた最高のレベルを選び、`max` しか挙がっていなければ null、`deepReplaceValue` は差し替えた箇所があるときだけ true） |
| `route-plan.test.ts` | `buildRoutePlan`（body parse、面解決、transformer 引き当て、gemini はパスのモデルを `body.model` に畳み込むこと）。面の `deniedTargets` は 400 でモデルを名指しし、他の面には効かないこと。**Plan のトークン**: 載っているモデルはそのまま、bare 名は載っているモデルが 1 つだけなら解決、モデルを書かなければ `defaultModel`、載っていないモデルは `/v1/messages`・`/v1/chat/completions`・`/v1/responses`・Gemini の各面で 403（それぞれの封筒、メッセージにモデルと許可リスト）、載っている名前でもプロバイダ接頭辞が違えば書き換えずに拒否、Plan の無いトークンは検査しない |
| `candidate-chain.test.ts` | `buildFailoverChain` — primary の後ろに、素のモデル名を持つ他のプロバイダ（`RoutePlan.fallbacks`）をその順で並べること（subscription primary が api_key fallback を保つ、同 provider も通る）、重複排除、exhausted 除外と全滅時の順序維持 |
| `chain-failover-cooldown.test.ts` | 429 後の枯渇マークと cooldown |
| `chain-failover-account.test.ts` | 試行がどのサブスクアカウントで走ったか（`attemptAccountOf`）。OAuth transformer が試行のリクエストに刻んだ `subAccountId` が session の最後の解決より優先されること（同じ session の並行リクエストに上書きされないため）、成功した試行はそのアカウントの枯渇マークを外し、刻みが無ければ推測でマークに触らないこと |
| `openai-models.test.ts` | `GET /v1/models` の envelope と `provider,model` id、単価とコンテキスト長 |
| `codex-mcp.test.ts` | Codex MCP サーバー（`/codex`）。`codex-mcp` スコープを明示したトークンだけが入れ（スコープなし・他の面だけのトークンは 403、無効なトークンは OAuth へ誘導しない 401）、`GET` は 405、SDK の知らないプロトコルバージョンを受けること、MCP SDK のクライアントが接続・一覧・呼び出しできること。`ask` が Codex の `/responses` に固定で届き、RequestLog に `surface = codex-mcp` とスレッド id のセッションで残り、`thread_id` で履歴と instructions を引き継ぎ、他のトークンのスレッドは読めないこと、Codex に無いモデルは上流を呼ばずに断ること。プランの利用枠をハンドシェイクと `status` では消費せず `ask` で消費し、埋まった枠が 5 時間の上限とリセット時刻を名指して断ること、`status` が枠ごとの使用量・上限・リセット時刻を返し、上限の無いプランでは返さないこと、プランに無いモデルを既定モデルに差し替えず断ること（`generate_image` も、プランに無い画像モデルは上流を呼ばずに断り、載っていれば描くこと）。`generate_image` が画像とダウンロード URL（`x-forwarded-proto` を反映）を返し、URL から同じバイトが取れること。`status` が Codex アカウントの窓・バンク済みリセットと使えるモデルを上流を呼ばずに返すこと。長い呼び出しの間の progress / ログ通知、ファイル鍵の形式、画像形式の判定、`output_text` の取り出し |
| `access-log-request-id.test.ts` | アクセスログの `reqId` |
| `oauth-export-credentials.test.ts` | 認証情報エクスポート |
| `oauth-import-credentials.test.ts` | 認証情報の取り込み。資格情報ファイルでない JSON と account id の無い Codex 資格情報を上流に問い合わせる前に 400 で断ること、上流が拒否した資格情報は（refresh token があれば 1 回 refresh を試したうえで）400 で断り何も書かないこと、refresh で通った場合は回転後の grant を保存すること、上流に届かなければ 502 で何も書かないこと、受理されたアカウントが `live` で保存され同じリクエスト内で `SubAccountUsage` / `SubAccountQuota` まで埋まること |
| `subscriptions-refresh.test.ts` | `POST /api/subscriptions/refresh`（Providers 画面の Refresh のアカウント側）。プロファイル再同期と 5 分キャッシュを迂回した usage 取得が `SubAccountQuota` / `SubAccountUsage` に着地し、`UsageSnapshot` には書かないこと。body 無し・`{}` では無効プロバイダのアカウントを呼ばないこと、`{ provider }` ではそのプロバイダのアカウントだけを無効化されていても同期・取得して他を呼ばないこと、subscription プロバイダに無い名前は 404 で何も呼ばないこと、失敗アカウントを名指しして行を触らないこと、同じスコープの同時呼び出しが 1 回の上流パスに合流すること、`/sync` の契約が変わらないこと。さらに Refresh がルーティングの状態も同期し直すこと — 最新の値で上限を下回ったアカウントの枯渇マークを外し上限のままなら残す、モデルのマークはそのモデルに効く窓で判定する、provider のマーク（`insufficient_quota`）は自前の cooldown に任せる、上流の取得に失敗したアカウントはマークを保つ、応答を返す前に routing snapshot を作り直す |

### `__tests__/llms` — ルーティングと変換

| ファイル | 担保しているもの |
|---|---|
| `inbound-surfaces.test.ts` | 面レジストリ。登録済み transformer 全件について「旧分岐が返す関数 === 記述子の `aggregateSse`」を突き合わせる |
| `router.test.ts` | `subscriptionKindOf`（429 をどのベンダの窓に付けるか）と `routeRequest` のスタンプ — 呼び出し側の model は変えず、passthrough として記録し、fallbacks は空。サブエージェントタグは記録・除去され、値は読まず（実在の target を名指しても）、旧綴り `<CCR-SUBAGENT-MODEL>` も受理し、閉じていないタグは存在扱いで残し、第 2 system ブロック以外・単一ブロックの system では印にならない |
| `subagent-tag.test.ts` | `stripSubagentTag` がタグの**有無**を返すこと（値は読まない）、閉じたタグを in-place で除去すること、閉じていないタグは存在扱いで残すこと、旧綴り `<CCR-SUBAGENT-MODEL>` も受理すること。`routeRequest` を通した記録は `router.test.ts` が見る |
| `tokenizers/tool-result-image.test.ts` | `tool_result` に入れ子になった image が base64 長ではなくテキスト分として数えられること（tiktoken / huggingface 両方） |
| `provider-registry-chain.test.ts` | `apiStyle` + `authMode` からの chain 導出と、chain 無しプロバイダの登録拒否 |
| `openai-endpoint.test.ts` | OpenAI の Base URL の付け替え（`retargetOpenAIUrl` / `redirectedOpenAIUrl`）。`/chat/completions` ⇄ `/responses`、末尾スラッシュ・クエリ・フラグメントの保持、すでに目的の形の URL はそのまま、どちらの形でもない URL（proxy の別パス、Codex の backend root、MiniMax の独自パス）は null、パスの途中や接頭辞だけの一致は拾わないこと |
| `openai-base-url-pipeline.test.ts` | 実レジストリと `runPipeline` を通し、ループバックの上流で、1 つの OpenAI provider の Base URL がどちらの形でも、Chat のモデルは `/chat/completions`（bypass 経路は `auth()` が URL を直す。`/v1/responses` 経由の変換経路も同じ）、Responses に切り替えたモデルは `/responses` へ Responses の body（`reasoning` オブジェクトと `max_output_tokens`、`reasoning_effort` / `messages` は無い）で届き、呼び手の形式で返ること |
| `transformers/openai-base-url.test.ts` | Chat 段・Responses 段が出す URL（形が合っていれば何も足さない、付け替え、クエリ保持、どちらの形でもなければ保存値のまま、Codex の backend root は触らない）、bypass の `auth()`、モデル別 chain を持つモデルでは Chat 段が body に触れないこと（`reasoning` が残る）と、そのあとの Responses 段が effort を `reasoning` オブジェクトで送ること |
| `sse-aggregate.test.ts` | 4 つのワイヤ語彙それぞれの SSE→JSON 畳み込みと、その手前のガード（`findSseStreamDefect`）— 使えるイベントが 0 のストリームと上流エラーイベントを畳まず拒否し、単に途中で切れただけのストリームは従来どおり畳むこと |
| `codex-stream-failure.test.ts` | 200 を返した後の Codex ストリームで `response.failed` / `error` / `response.incomplete` が来たとき、`/v1/messages` には上流のメッセージを持つ Anthropic の `error` イベントが 1 つだけ届き（後ろに `message_stop` を付けない）、非ストリームの再試行ではエラーコードに応じた 400 / 429 / 529 / 502 になること。`max_output_tokens` での incomplete は `max_tokens` で終わる通常のメッセージになること。`message_start` の無いストリームは `message_delta` + `message_stop` の 2 イベントではなく 0 イベントで閉じること |
| `tool-result-images.test.ts` | `tool_result` の画像が base64 テキストにならないこと。unified では image part のまま保ち、Responses（Codex）では `function_call_output.output` の `input_image` 配列、Chat Completions と Gemini では tool メッセージ群の直後の user メッセージへ移すこと。テキストだけの配列は JSON ではなくテキストそのものになること |
| `bypass-header-strip.test.ts` | bypass 時の hop-by-hop ヘッダ除去 |
| `session-id.test.ts` | `thread-id`（Codex CLI 0.158 の綴り）/ `thread_id` / `x-claude-code-session-id` / ランダム UUID の解決順 |
| `reasoning-effort.test.ts` | `RequestLog.reasoningEffort` が上流へ実際に送った値であること。Anthropic の `output_config.effort`・Chat の `reasoning_effort`・Responses / Codex の `reasoning.effort` の 3 形から読み、無指定・空文字・文字列でない値・壊れた入れ物は null になること。Auto が挿入した段階と手動設定が呼び出し側の値を置き換えた結果が、書き換え後の本文から読めること |
| `persona-inbound-gate.test.ts` | ペルソナ挿入が `/v1/messages` **だけ**で走ること（`routeRequest` を直接呼び、OpenAI 形の面では `body.system` に触らないこと）。`inboundPath` の無い旧呼び出しは `/v1/messages` 扱いで、呼び手の system と合成し、ライブラリに無い id は何もしない |
| `openai-responses-*.test.ts` / `anthropic-response-to-chat.test.ts` / `gemini-*.test.ts` / `response-format-converter.test.ts` | 各ワイヤ形式の双方向変換とストリーム。`openai-responses-lite.test.ts` は Lite の各区間に加えて、関数しか無いワイヤ（Chat / Gemini）へ namespace・custom ツールが関数として下ろされること（`exec` は文字列 1 つ `input` を取り grammar を説明に持つ、履歴の custom 呼び出しは `{"input": …}` の関数呼び出し、namespace と `tool_call_type` は出ない）と、戻りでその呼び出しが呼び手の宣言どおりの `custom_tool_call` / namespace 付きに引き上げられること（ストリームでは custom の入力をその呼び出しが閉じるまで保持し、delta の連結が `.done` の生テキストと一致する）、上流が自分で namespace や kind を言った呼び出しには触れないことも見る |
| `anthropic-response-to-chat-stream.test.ts` | Anthropic の SSE が Chat の chunk へイベントごとに変換されること（thinking → `delta.thinking`、text、`input_json_delta` が分割された tool_use → index 付き `tool_calls`、入力の無い tool は `{}`、server tool のブロックは渡さない、`message_delta` で finish_reason と cache を含む usage、`message_stop` で `[DONE]`、`error` イベントは上流失敗用の `{error:{…}}` chunk で後ろに何も付けない）。その先の Responses SSE でも item・usage が正しく、エラーは `response.failed` になること。Lite の呼び手には Claude の `exec` 呼び出しが namespace 付き `custom_tool_call` として、入力が生の JavaScript で届くこと（ストリーム・非ストリーム両方） |
| `claude-conversion-pipeline.test.ts` | 実レジストリと `runPipeline` を通し、ループバックの上流で、`/v1/responses` → Anthropic API キーと `/v1/chat/completions` → Claude サブスクが Anthropic Messages（キー / bearer・OAuth beta・identity）で送られ、それぞれの形式で返ること、RequestLog の usage が生の Anthropic から読まれること。同じサブスクの `/v1/messages` は bypass のまま `auth()` の形で送られ、ストリームがバイト単位でそのまま返ること |
| `tool-lowering.test.ts` | 下ろしたツールの名前の規則（衝突しなければ素の名前、衝突すれば `namespace__name`、トップレベルの関数は名前を保つ、3 つのワイヤが受ける文字へ整える）、応答側が呼び手の body だけから同じ対応を出すこと、引き上げの規則、Codex CLI 0.160 の Lite fixture が Chat と Gemini へ関数として届き 2 ターン目でも throw しないこと |
| `claude-code-oauth-nonbypass.test.ts` | OAuth chain が bypass に落ちない経路 |
| `transformers/*.test.ts` | 各 transformer のリクエスト整形と OAuth 基底 |
| `transformers/anthropic-request-from-unified.test.ts` | OpenAI の面から Claude へ回したリクエストが、サブスク・API キーどちらの step でも Anthropic Messages として**丸ごと**期待どおりであること（system の巻き上げと identity、画像ブロック、`tool_use` / まとめた `tool_result`、`tool_choice` と `disable_parallel_tool_use`、effort → `output_config`、`max_tokens` の既定値、温度の 0–1 への丸めと `top_p` を同時に送らないこと、サンプリングや強制ツール選択を拒むモデルには送らないこと、厳格な JSON schema だけ structured output にすること、Chat 専用の項目を送らないこと、ツール一覧・system・会話の最後のブロックに cache breakpoint を置き、呼び手のものと合わせて 4 つを超えないこと）。tool loop を続けるターンでは手動 thinking を外し、adaptive は残し、何も thinking を有効にしないこと。Codex CLI 0.160 の Lite fixture（1・2 ターン目）が関数に下ろされて届くこと |
| `transformers/codex-request.test.ts` | Codex へのリクエストが、どの入口から来ても Codex CLI 0.158.0（`codex exec`）の classic 形になること。呼び手の system は `input` 先頭の developer メッセージになり（`json_object` の "json" 検査はここを見る）、`instructions` は Responses の呼び手だけが自分で書く。CLI が送るトップレベルの項目だけを送り、`tool_choice: 'auto'`・並列ツール呼び出し（呼び手が切ったときだけ false）・`text.verbosity: 'low'`・`include: reasoning.encrypted_content`。ヘッダと `client_metadata` が CLI のもの（`x-codex-turn-metadata` は CLI と同じ項目順）。暗号化 reasoning が thinking ブロックの signature に封入されてクライアントへ届き、次のターンに同じアカウントへだけ reasoning 項目として戻ること（別アカウント・別プロバイダ・Anthropic・Gemini には行かない）。1 つの応答の 2 つのツール呼び出しが 2 つの `tool_use` になること。CLI 0.160 の実リクエスト（`__tests__/fixtures/codex/cli-0.160-*.json`）のうち Responses Lite の形は、`additional_tools` のツールがトップレベルの `tools`（namespace のまま、`exec` の grammar も保つ）になった classic 形で送られ、2 ターン目の namespace 付き `custom_tool_call` と content part 配列の出力がそのまま上流へ届き、Lite のヘッダは転送されないこと。classic の形は従来どおりであること |

### `__tests__/services` — サービス層

| ファイル | 担保しているもの |
|---|---|
| `config/envelope.test.ts` | `config.json` の JSON/JSON5 読込、環境変数展開、`process.env` 反映 |
| `config/migrate-home-dir.test.ts` | 旧 HOME_DIR からのコピー → 検証 → 旧削除。冪等性と、検証失敗時に原本を残すこと |
| `config/api-style.test.ts` | 行に保存する request shape。catalog vendor は名前で決まりペイロードは動かせない。Custom は運用者が選んだ 3 形式を保ち、形式を含まない保存は行の値を残し、`gemini` は採らず、行がまだ無ければ名前由来の既定。モデル別の上書き（codex 系は Responses 専用）は catalog vendor だけで、Custom は名前から導かない |
| `config/log-dir-lazy.test.ts` | ログディレクトリの遅延作成（`migrateHomeDir` より先に作らせない） |
| `failover-state.test.ts` | 枯渇マークとその失効。モデル単位のマークは同 provider の他モデルを塞がず、provider 単位のマークは全モデルを塞ぐこと、`clear*` が即座に外すこと（モデルのマークを外しても provider のマークは残る）、`modelMarksFor` が 1 provider の生きたモデルマークだけを列挙すること |
| `plan-model.test.ts` | `decidePlanModel`（純関数）。Plan の無いトークンは呼び出し側に任せ、載っている `provider,model` はそのまま、bare 名は載っているモデルがちょうど 1 つなら解決・複数のプロバイダが持つなら bare のまま（provider の優先度が決める）、モデルを書かないときだけ `defaultModel`、載っていないモデルと、載っている名前の別プロバイダ接頭辞と、どの載っているモデルも持たない bare 名は denied で、メッセージにモデルと許可リストが入る |
| `session-account-router.test.ts` | ハードリミット除外 → sticky → balancingScore の 4 段 |
| `usage-headroom.test.ts` | `drainTarget` / `getKindWindowHeadroom` の算術。**src に呼び出し元の無い関数のテスト**（`usage-service.ts` が再 export しているだけで、ルーティング経路からは呼ばれない） |
| `usage-fetch-force.test.ts` | usage 取得の `forceRefresh`（TTL 内のキャッシュを迂回して上流を呼び、再キャッシュする）と `enabledProvidersOnly`。既定の経路が変わらずキャッシュを返し、失敗時は直前の値を残してアカウントを `failed` に名指しすること。5h が 100 % でも 7d / Fable は上流の値とリセットのまま返すこと（100 % 扱いはスケジューラだけの話） |
| `model-test/subscription-probe.test.ts` | Codex サブスクの Test が、プロキシと同じ `openai-responses` → `codex-oauth` で request を組むこと。ChatGPT バックエンドが拒否する `max_output_tokens` を送らない、`messages` を残さない、`/responses` へ account id と `originator` 付きで送る |
| `model-test/probes.test.ts` | api_key の Responses 疎通確認は `max_output_tokens: 16` を送り続けること（公開 Responses API は 16 未満を 400 にする）。Codex 側と取り違えて「直さない」ための対。Base URL がどちらの形でも、Chat の疎通確認は `/chat/completions`、Responses のそれは `/responses` へ行き（どちらの形でもなければ Chat は保存値のまま、Responses は末尾に足す）、クエリは保たれること |
| `subscription-account-sync-service.test.ts` / `subscription-account-sync/crypto.test.ts` | サブアカウント同期と `RIALTO_ACCOUNT_ENCRYPTION_KEY` による暗号化 |
| `codex-auth.test.ts` | Codex のトークンリフレッシュ |
| `cost-service.test.ts` | `computeCosts` が cache write を TTL で分けて値付けすること — 5 分は入力単価の 1.25 倍、1 時間は 2 倍。`cacheWrite1hTokens` は `cacheWriteTokens` の内訳なので足さずに割ること、内訳が総量を超えたら総量で切ること、価格の無いモデルは価格無しのまま |
| `codex-reset-service.test.ts` | Codex のバンク済みリセット（上流はスタブ、クレジット一覧は実レスポンスの fixture）。使えるのは available かつプランが対応するクレジットで、失効の近い順に並ぶこと、消費はそのクレジットを冪等キー付きで送り、返す前に使用量を取り直して routing に反映させること、ベンダの拒否は 409（取り直さない）、ベンダ障害は 502、Claude のアカウントは何も送らずに拒否、ルートがサービスのステータスで答えること |
| `routing-scheduler/collector.test.ts` | 上流の使用量（Claude の 5h / 7d / per-model、Codex の primary / secondary）を `SubAccountQuota` の窓へ写すこと。Codex は上流の `window_seconds` を保ち（Claude は固定長）、読めない `resetsAt` は null にする |
| `routing-scheduler/targets.test.ts` | quota snapshot が target 1 つについて言うこと（`targetQuotaOf` / `soonestResetOf`）。`exhausted` は chain walker がプロバイダを飛ばす根拠なので「その model の後ろの全アカウントがいま使い切っている」以外では立てないこと — 片方に余裕がある・未取得や古い読みのアカウントが混ざる・アカウントが無いなら開いたまま。Fable は自分の週次窓を読み、使い切っても Sonnet の予算には響かないこと。ペースは予算に対する % で小数 1 桁まで運び、100 を超えても丸めず、どの窓も判定に早すぎれば予算がどうであれ null |
| `routing-scheduler/pace.test.ts` | ペースの見込み `projectedUsage`（適応的 reasoning effort が読む）。使用率 ÷ 経過割合（半分の時点で半分使えばちょうど使い切り）、窓の 10 % 未満は判定しない、最も厳しい窓が効く（5h の急な消費は余裕のある週次に勝つ）、Fable は自分の週次窓で判定する、アカウントはプラン容量で重み付け（Max20 は Pro の 20 倍）、読みの無い・古いアカウントは「暇」と読まずに外す |
| `routing-scheduler/tick-targets.test.ts` | tick が quota を出す target は有効なサブスクプロバイダの有効なモデルすべてで、api_key プロバイダの分は出さないこと、使い切った週次窓がリセットまで target を止めること |
| `routing-scheduler/tick-concurrency.test.ts` | tick が重ならないこと。同時に頼まれた 2 回は 1 回になり、実行中の republish はそれを待ってもう 1 回だけ走らせ（合流すると書き込み前の読みを公開してしまうため）、何も走っていなければ自分で 1 回走らせること |
| `routing-scheduler/account-limit.test.ts` | quota snapshot を作る前に、5h か 7d（codex は primary / secondary）が 100 % に達した account の残りの窓を 100 %・到達した窓のうち遅い方のリセットとして扱う `holdSpentAccount`。99 % では何も変えない、per-model 7d の到達は波及しない、自前でも使い切った窓がそれより後にリセットするなら自分の値を残す、上流が返していない窓は作らない |

### `__tests__/shared` — ブラウザにも載るコード

| ファイル | 担保しているもの |
|---|---|
| `custom-provider.test.ts` | Custom プロバイダの純粋な規則。形式は 3 つで `gemini` は含まない。名前は slug（長さ上限は含む、大文字・空白・カンマ・先頭の `-` は charset）、全ビルトイン vendor・subscription preset・`claude-code*` 接頭・`custom` / `gemini-cli` / SPA のルート片は `reserved`。Base URL は http(s) のみで、認証情報・クエリ・フラグメントつきを拒否し、末尾の `/chat/completions` / `/responses` / `/messages` は「endpoint を直接入力した」と読み、プライベートアドレスは許可。保存する endpoint は `/v1` を足さず二重にもせず、入力した tail は選んだ形式に付け替える。モデル一覧の候補 URL は重複せず `/v1/v1` にならない。フォームとサーバが同じ答えを読む |
| `transformer-chain.test.ts` | `apiStyle` × `authMode` → chain の写像。サーバとフロントが**同じ関数**を読むので、この 1 本が両方を守る。モデル別 chain は、運用者が切り替えた任意のモデル（名前によらない）に付き、Base URL の形には左右されず、provider と同じ style や anthropic（足す段が無い）には付かないこと |
| `constants.test.ts` | `HOME_DIR` の解決（`RIALTO_HOME_DIR` の優先） |
| `model-version.test.ts` | モデル id から読むリリースの新旧（`newestFirst`）。バージョンの数字が先に効き、8 桁の日付は同じバージョン同士でしか効かず、日付なしが先、最後は名前で全順序になること |
| `plan-capacity.test.ts` | `planCapacityWeight` の席の重み。Claude は `rate_limit_tier` から Max 5x / 20x を読み、Codex は `plan_type` の `prolite` を 5・`pro` を 20 と数える。Providers 画面の Quota 列とスケジューラのプール予算が同じ関数を読むので、この 1 本が両方を守る |
| `plan-label.test.ts` | プランの表示名。Claude は `rate_limit_tier` から「Max 5x」/「Max 20x」、基本プランは「Pro」。Codex は `plan_type` の `prolite` を「Pro 5x」、`pro` を「Pro 20x」、基本プランは「Plus」。Activity → Usage がアカウントごとに出す名前 |

### `__tests__/vendors` — ベンダー adapter（`src/vendors/`）

fetch はスタブで、ネットワークには出ない。fixture を再生する `__tests__/providers` とは別。

| ファイル | 担保しているもの |
|---|---|
| `custom.test.ts` | Custom プロバイダの接続時のモデル一覧取得 `fetchCustomModels`。OpenAI 形式は `/v1/models` に Bearer、Claude 形式は `x-api-key` + `anthropic-version`、`/v1` で終わる Base URL を `/v1/v1/models` にせず、入力した endpoint の tail は外す。リダイレクトは辿らず（鍵を別 origin へ渡さない）行き先を理由に載せ、最初の候補が空・404 なら次の候補を試して、その ids を採る。ids は重複を畳み順序を保ち、Google 形も読む。失敗は例外にせず `{ ok: false }` で、理由は最初の候補（運用者が入力したアドレス）の 401 / 空 / 形が違う / JSON でない / 接続エラー / タイムアウト。http(s) でない Base URL は fetch に届かない。失敗が手入力へのフォールバックの入口になる |

### `__tests__/parity` — 面ごとの挙動パリティ

4 つの受け口が同じ振る舞いをすることを、面をまたいだマトリクスで確認する。軸ごとの実体が
`streaming` / `non-stream-aggregate` / `tool-use` / `thinking` / `image-input` /
`system-prompt` / `cache-tokens` / `usage-record` / `error-envelope` / `failover-429` /
`gemini-request-conversion` の各ファイル。かつてあった `routing-mode`（routed / passthrough の
両方を 4 面で確かめる軸）と `routing-lanes` は、ルーティングそのものの廃止（v3）で削除した。
Plan のモデル判定が 4 面で同じ 403 を返すことは `api/route-plan.test.ts` が見る。

`matrix.test.ts` は**ドキュメントを検査するテスト**である。`docs/architecture/inbound-parity.md`
を実際に読み、面の列が `INBOUND_SURFACES` と一致しているか、全セルがラベルで埋まっているか、
各行が実在するテストファイルを担保として挙げているかを確かめる。面を1つ足したときに列が1つ
足りない表が静かに残るのを防ぐため — **空白セルの洗い出しが成果物**である以上、表の側にも
「空欄を作れない」保証が要る。

### `__tests__/providers` — プロバイダ契約（フィクスチャ再生）

`bun run test:providers` の対象。`__fixtures__/` に記録した実リクエスト／実レスポンスを
再生して、SSE 形状・最小応答健全性・subscription の動的モデル行列を確認する。

| ファイル | 担保しているもの |
|---|---|
| `claude.test.ts` / `codex.test.ts` / `openai.test.ts` / `gemini.test.ts` | ベンダーごとの往復 |
| `scenarios.test.ts` | tool-use / system / multi-turn / thinking の各ケースのフィクスチャ |
| `fixture-schemas.test.ts` | フィクスチャ自体がスキーマに合っていること |
| `fixtures.ts` / `helpers.ts` | Rialto API 呼び出し、SSE パーサ、モデル行列取得 |

フィクスチャの取り直しは `scripts/capture-fixtures.ts`。記録・リクエスト行列・一時キーの
注入／復元は `scripts/capture-fixtures/` の各モジュールに分離している。

### `__tests__/scripts` — 開発スクリプトの契約

| ファイル | 担保しているもの |
|---|---|
| `capture-fixtures.test.ts` | 分割前と同じリクエスト行列・順序・本文と replay hash、資格情報の redaction、記録／skip／force、HTTP エラーと通信失敗の区別、subscription の有効モデルの列挙、一時 API キーの注入／復元が全プロバイダの設定を保つこと。fetch はローカル応答に差し替え、上流や開発 DB は触らない |

### `__tests__/e2e` — Providers のブラウザ契約

既存の :16175 を使い、サーバーが無ければ skip する。下のアカウント操作テストは API を
ブラウザ内で stub し、実アカウントや上流ベンダーを更新しない。

| ファイル | 担保しているもの |
|---|---|
| `subscription-account-toggle.test.ts` | Edit → Toggle → Save、Revert、手で戻した変更の no-op、最後の有効アカウントの OFF と再有効化、保存失敗時の読み直し、スマホでは状態だけを表示すること |
| `subscription-account-status.test.ts` | valid / invalid / unknown バッジ、長い認証エラー本文の非表示、長いアカウント名の省略と tooltip、リセット表示の nowrap、デスクトップ／スマホで横にはみ出さないこと |
| `subscriptions-auto-refresh.test.ts` | 30 秒ごとの GET による背景更新、カウントダウン、編集の保護、失敗時の成功データ保持、遅い応答の取消と重複防止、非表示タブの停止と復帰、Subscriptions 一覧での更新と API-key 詳細で更新しないこと |

### `__tests__/preset`

| ファイル | 担保しているもの |
|---|---|
| `schema.test.ts` | `src/schemas/domain/preset.ts` の `JsonValueSchema` / `JsonObjectSchema` |

`JsonValueSchema` は `schemas/api/config.ts` と `schemas/domain/config.ts` の `.catchall`
を支えているので、これは**本番経路のテスト**である。
`JsonObjectSchema` の方はこのテスト以外に読み手がいない。

かつてここにあった manifest スキーマ（`PresetFileSchema` / `PresetMetadataSchema` /
`ConditionSchema`）と条件評価のテストは、対象のコードごと削除された。**ファイルのパスは
変えていない**ので `bun run test` のグロブ（`__tests__/preset`）はそのままで正しい。

「preset」と呼ばれる機能はもう無い（`RoutingPreset` も、Settings → Presets も、
`src/lib/presets/` も）。`CLAUDE.md` の「Things that are easy to get wrong」も参照。

## 未カバー領域

| 領域 | 状況 |
|---|---|
| UI コンポーネントのレンダリング | ロジックは `__tests__/lib/rialto/` で切り出してテストしているが、レンダリング自体は `ui-mock-diff` スキルのスクリーンショット差分に委ねている |
| Redis / BullMQ ジョブ | 起動が fire-and-forget なので、ジョブ本体の統合テストは無い |

## 関連

- `.claude/skills/ui-mock-diff/SKILL.md` — UI のスクリーンショット差分ワークフロー
- `docs/architecture/pipeline-overview.md` — テストが守っている実装の全体像
- [`docs/architecture/routing.md`](./routing.md) — リクエストの行き先の決まり方（Plan のモデル判定・素のモデル名の解決・`deniedTargets`）と quota snapshot。`api/route-plan` / `services/plan-model` / `routing-scheduler/*` が守っている契約の出どころ
