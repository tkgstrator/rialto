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
| `routing-constraints.test.ts` | Routing 画面の制約セル。各セルの編集が自分のノブだけを書き換えること、Error-rate skip はパーセントで編集し 0〜1 の比率で保存すること、パーセントは 0〜100 の整数・Min samples は非負整数だけ通ること |
| `tier-map.test.ts` | Routing 画面のティアマップ。ドラフトが PUT の形だけを持ち手で戻した編集を変更扱いしないこと、ルートの解決先（読み込んだプロファイル → エイリアス一覧 → 保存待ち）、スケジューラの `targets` から State（ok / N% used / exhausted / alias unset / off）を出すこと、ティア代替の判定と並べ替え・重複・フッターの件数 |
| `long-context-beta.test.ts` | `context-1m-*` beta ヘッダの取り回し |
| `message-content.test.ts` | メッセージ本文の正規化 |
| `models-build-rows.test.ts` | Providers 画面のモデル行の組み立て |
| `passthrough-denial.test.ts` | passthrough 面の `deniedTargets`。routed な面では判定しないこと（`body.model` はティアマップのルートが置き換え済みで、呼び出し側の文字列はもう上流へ行かない）。一覧に無い target・空の一覧・面レジストリ外のパス・空の target は拒否しないこと |
| `persona-clear.test.ts` | 「ペルソナ無し」への戻し方（トップレベル `ActivePersona` の null / 空文字 / 欠落） |
| `hosts-web-search.test.ts` | `hostsWebSearch`（`src/shared/transformer-chain.ts`）。Anthropic / Responses / Gemini は `web_search` を運べて Chat Completions は運べないこと、api_key プロバイダではモデル単位の apiStyle 上書きが勝ち、subscription プロバイダはそれを無視し、旧い subscription 行はベース URL から推定すること — chain の導出と同じ規則なので、Routing 画面のバッジとティアルーターの Web 検索ゲートが実際に走る chain とずれない |
| `provider-routable.test.ts` | `Provider.enabled` を Routing が絞る集合と Providers 画面の表示が一致すること |
| `thinking-signature-filter.test.ts` | `rialto_` プレフィクスの thinking signature 濾過 |
| `update-check.test.ts` | 更新チェック: バージョン比較（`v` 付きタグ・prerelease・読めないタグ）と、取得失敗を「最新です」に畳まないこと、成功だけをキャッシュすること |
| `rialto/format.test.ts` | 表示フォーマッタ（金額の有効数字など） |
| `rialto/provider-draft.test.ts` | プロバイダ詳細の Edit → Save が書くもの。手で元に戻した変更は何も書かないこと、プロバイダ・モデルのスイッチとキーは読み込んだ行を土台にした 1 回の upsert に載り、ティアエイリアスと effort は変わったものだけが個別の書き込みになること（upsert には載せない）。エイリアスを新しく向けたモデルは ON として描かれ（サーバ側の昇格がモデルを有効にするのと揃える）、スイッチの切れたモデルの昇格だけなら upsert を伴わないエイリアスの書き込み 1 回、解除はモデルを名指さない書き込みで、エイリアスの書き込みは帯の順に並ぶこと |
| `rialto/provider-tier-aliases.test.ts` | プロバイダページのティアエイリアス帯。後から現れたモデルはエイリアスを動かさずに「new」として数えて印を付けること、ピッカーは現在のモデル → 新しい候補 → それ以外の全モデルの順に出すこと（Codex や OpenAI のようにモデル名から tier が読めないプロバイダでも選べるように、名前で合う候補だけに絞らない）、Alias 列がモデルごとに担っている tier を帯の順で出すこと |
| `rialto/account-extras.test.ts` | アカウント行の付帯情報（API 換算の使用量と Codex のバンク済みリセット）をアカウント id で引けること、欠けた読み取りを null のまま残すこと、割安度と失効日のフォーマッタ |
| `rialto/redact-tool-arguments.test.ts` | `REDACT_TOOL_ARGUMENTS` の除去処理 |
| `rialto/settings/access-config.test.ts`<br/>`rialto/settings/access-tokens.test.ts`<br/>`rialto/settings/envelope.test.ts` | Settings 画面の各フォームのロジック |
| `rialto/settings-content/persona.test.ts`<br/>`rialto/settings-content/statusline.test.ts` | Settings のサブ画面のロジック |

### `__tests__/db` — DB を張った統合テスト

`TEST_DATABASE_URL` が無ければ丸ごと skip する。`bun run test` の対象。

| ファイル | 担保しているもの |
|---|---|
| `config-service.test.ts` | `applyUiConfig` / `composeUiConfig` の往復整合、モデル削除が外すティアエイリアスの警告（ルート自体は残り、エイリアスが再設定されるまで飛ばされる）とプロバイダ削除で cascade するルートの profile / 要求ティア単位の警告、Providers だけの保存がティアマップに触らないこと、退役キー（`APIKEY` / `Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK`）を警告付きで捨て・ディスクから剥がし、`GET /api/config` にも出さないこと、トップレベル `ActivePersona` の往復、永続化 |
| `upsert-provider.test.ts` | Provider の upsert（重複名・モデル差分）。1 プロバイダの編集が他のプロバイダの SubAccount やそれを名指すルートを消さないこと、CRUD 経路のモデル削除が外すティアエイリアスを報告し、プロバイダ削除が一緒に消えたルートを profile / 要求ティア単位で報告すること（名指すルートが無ければ何も報告しない） |
| `disabled-targets.test.ts` | 無効な Provider / Model がどの経路からも送られないこと — ルートの解決がルート自身のスイッチとターゲットのスイッチ（`targetEnabled`）を分けて返し、セレクタがターゲットの切れたルートを飛ばすこと、スイッチの切れたモデルをエイリアスで昇格すると ON になること、registry が有効なものだけを持つので passthrough の `provider,model` も `resolveInvocationForModel` が拒否すること、bare 名の解決、サブスクリプションのアカウントプール |
| `tier-route-service.test.ts` | 保存されるティアマップ。保存はプロファイル全体の置き換えで、順序どおり・全ティアが揃って読み返せること、存在しないプロバイダと重複は警告付きで捨て、エイリアス未設定のルートは警告付きで残すこと、予約キー `passthrough` はルートを持てないこと、制約はブロブへマージされ置き換えではないこと、プロファイル一覧が既定を先頭・予約キーを末尾に出すこと |
| `tier-alias-service.test.ts` | プロバイダのティアエイリアス。後から現れた同 tier のモデルは置き換えではなく `isNew` の候補になること、全プロバイダの 4 tier が設定の有無によらず並ぶこと、昇格がスイッチの切れたモデルを ON にすること、未知のプロバイダ / モデルの拒否と解除の結果、Claude のサブスク preset が tier ごとに preset の先頭のモデルでエイリアスを作り既存のエイリアスは触らないこと、Claude のファミリ名を持たない Codex には作らないこと |
| `backfill-tier-routes.test.ts` | seed 時に旧チェーンをティアマップへ変換する処理。default / agent のチェーンを変換して `chainBackfilledAt` を打ち 2 回目は何もしないこと、すでにルートを持つプロファイルは印だけ付けること、既定プロファイルが先にエイリアスを取り他のプロファイルはそれを通して解決し、その旨をメモに残すこと、チェーンの無いプロファイルはルート無しで印が付く（空レーンと同じく素通しになる）こと |
| `account-usage-service.test.ts` | アカウントごとの API 換算使用量。いまの週次窓の開始（リセット時刻から窓の長さを引く。Codex は上流の窓の長さを使い、リセットが過ぎていればそこから新しい窓、読めなければ直近 7 日）、サブスクのモデルを同名の有料モデルの価格で換算すること、「価格不明」（null）と「トラフィック無し」（0）を分けること、価格の無いモデルが価格の付いた分を消さないこと、割安度は額と月額の両方が要ること、各アカウントが自分の行しか見ないこと |
| `access-token-service.test.ts` | トークンの発行・解決・失効。保存は sha256 のみ |
| `inbound-surface-service.test.ts` | 面ごとの `routingMode` / `profileKey` の解決と `ensureInboundSurfaces` の冪等性 |
| `passthrough-profile.test.ts` | 予約プロファイル `passthrough`。プロファイルの選択肢には出るがティアマップとしては保存できないこと、面がこのキーを指せば `routingMode` が `routed` でも passthrough になり、実在のプロファイルへ戻せばルーティングが戻ること、このキーで保存された行があっても挙動を上書きしないこと |
| `overview-service.test.ts` | Overview 画面の集計クエリ。加えて quota 行にアカウントの API 換算使用量が載ること、failover フィードが 429 と拒否された資格情報を新しい順に出し、重みの行を出さないこと |
| `storage-service.test.ts` | ストレージ使用量の集計 |
| `helpers.ts` | DB 初期化／クリーンアップ、DB 利用可否ゲート |

### `__tests__/api` — HTTP 契約

| ファイル | 担保しているもの |
|---|---|
| `health.test.ts` | `/health` が管理ゲート（`adminAuth`）の外にあること、db / redis の両チェックを報告すること、`summarizeHealth` の切り分け（必須依存の失敗だけが 503。redis 落ちは degraded だが 200）、Redis プローブが未設定なら `skip`・到達不能なら hang せず `fail` |
| `local-access.test.ts` | ローカルブラウザ免除の判定（トンネル背後で常に loopback に見える問題込み） |
| `openai-bearer-auth.test.ts` | OpenAI 面が Bearer のみを受けること |
| `google-surface-auth.test.ts` | Gemini 面の `x-goog-api-key` / `?key=` |
| `request-log-events-auth.test.ts` | `/api/request-logs/events` がもう `?apikey=` を受けないこと — それを付けたリモートのリクエストは 401、ホスト上からのリクエストは通る |
| `error-shape.test.ts` | 3 種のエラー封筒の出し分け |
| `upstream-error.test.ts` | `PROVIDER_ERR_RE` の逆パースと verbatim 転送 |
| `route-plan.test.ts` | `buildRoutePlan`（body parse、面解決、transformer 引き当て、gemini はパスのモデルを `body.model` に畳み込みそこから要求ティアを読むこと）。routed な面ではティアの primary / fallbacks が plan に載ること、quota・health で止まったティアは `exhaustedBehavior='429'` なら各面のエラー封筒で 429 + `Retry-After`（429 マークの期限があればそれ）を返して plan を作らず、`'passthrough'` なら呼び出し側の model で送ること、空のティアと全ルート OFF は `'429'` でも呼び出し側の model で送ること、エイリアス未設定・web_search を運べるルートが無い・プロンプトが入るルートが無いは 400（anthropic / chat / gemini それぞれの封筒）で `'passthrough'` でも緩まないこと、passthrough 面の `deniedTargets` と routed 面がそれを見ないこと |
| `candidate-chain.test.ts` | `buildFailoverChain` — primary の後ろに selector が解決した fallbacks をその順で並べること（subscription primary が api_key fallback を保つ、同 provider も通る）、重複排除、exhausted 除外と全滅時の順序維持 |
| `routing-profiles.test.ts` | `/api/routing/profiles{,/{key}}`、`/api/tier-aliases`、`PUT` / `DELETE /api/providers/{name}/tier-aliases/{tier}`。保存したマップが各ルートをエイリアスで解決して読み返せ（モデル・受け付け可否・Web 検索・context window）、未設定のエイリアスは画面を落とさず null で読めること、予約キー `passthrough` の拒否、ティアマップでない body の検証エラー、スイッチの切れたモデルの昇格で ON になりエイリアス一覧に出ること、未知の provider / model と未設定エイリアスの解除が 404、プロファイル一覧が既定を先頭に出すこと |
| `chain-failover-cooldown.test.ts` | 429 後の枯渇マークと cooldown |
| `chain-failover-account.test.ts` | 試行がどのサブスクアカウントで走ったか（`attemptAccountOf`）。OAuth transformer が試行のリクエストに刻んだ `subAccountId` が session の最後の解決より優先されること（同じ session の並行リクエストに上書きされないため）、成功した試行はそのアカウントの枯渇マークを外し、刻みが無ければ推測でマークに触らないこと |
| `openai-models.test.ts` | `GET /v1/models` の envelope と `provider,model` id |
| `access-log-request-id.test.ts` | アクセスログの `reqId` |
| `oauth-export-credentials.test.ts` | 認証情報エクスポート |
| `oauth-import-credentials.test.ts` | 認証情報の取り込み。資格情報ファイルでない JSON と account id の無い Codex 資格情報を上流に問い合わせる前に 400 で断ること、上流が拒否した資格情報は（refresh token があれば 1 回 refresh を試したうえで）400 で断り何も書かないこと、refresh で通った場合は回転後の grant を保存すること、上流に届かなければ 502 で何も書かないこと、受理されたアカウントが `live` で保存され同じリクエスト内で `SubAccountUsage` / `SubAccountQuota` まで埋まること |
| `subscriptions-refresh.test.ts` | `POST /api/subscriptions/refresh`（Providers 画面の Refresh のアカウント側）。プロファイル再同期と 5 分キャッシュを迂回した usage 取得が `SubAccountQuota` / `SubAccountUsage` に着地し、`UsageSnapshot` には書かないこと。body 無し・`{}` では無効プロバイダのアカウントを呼ばないこと、`{ provider }` ではそのプロバイダのアカウントだけを無効化されていても同期・取得して他を呼ばないこと、subscription プロバイダに無い名前は 404 で何も呼ばないこと、失敗アカウントを名指しして行を触らないこと、同じスコープの同時呼び出しが 1 回の上流パスに合流すること、`/sync` の契約が変わらないこと。さらに Refresh がルーティングの状態も同期し直すこと — 最新の値で上限を下回ったアカウントの枯渇マークを外し上限のままなら残す、モデルのマークはそのモデルに効く窓で判定する、provider のマーク（`insufficient_quota`）は自前の cooldown に任せる、上流の取得に失敗したアカウントはマークを保つ、応答を返す前に routing snapshot を作り直す |
| `routing-scheduler-state.test.ts` | `GET /api/routing-scheduler-state`。起動直後は 404 ではなく空の snapshot を返すこと、公開済みの snapshot は target ごとの `exhausted` / `remainingBudgetPct` / `resetAt` と `soonestResetAt` を ISO 時刻で返すこと |

### `__tests__/llms` — ルーティングと変換

| ファイル | 担保しているもの |
|---|---|
| `inbound-surfaces.test.ts` | 面レジストリ。登録済み transformer 全件について「旧分岐が返す関数 === 記述子の `aggregateSse`」を突き合わせる |
| `route-request.test.ts` | `routeRequest` の通し契約（[routing.md](./routing.md) の結果の表）。要求ティアはモデル名から読み、ルートを順に試して最初に通ったものが `body.model`、残りが fallbacks になる。ゲートは 429 マーク（モデル単位・provider 全体）、snapshot の spent と `quotaSkipPct`（snapshot が知らない target は quota で止めない）、サンプル数に達してからの error rate、web_search、context window。ルートが無い・全ルートかターゲットが OFF のティアは `exhaustedBehavior` によらず素通しで 429 にしない／quota・health で全部止まれば `'429'` では `Retry-After`（429 マークの期限 → snapshot の reset → 既定 30 秒）、`'passthrough'` では素通し／エイリアス未設定・web_search を運べない・プロンプトが入らないは `routingRefusal` で `exhaustedBehavior` でも緩まず、quota で止まったルートが 1 本でも混ざれば refusal ではなく exhaustion／マップ読込失敗・例外は呼び出し側の model のまま error ログ／token の `passthrough` profile と passthrough 面はマップを飛ばす／サブエージェントタグは除去・記録されるがレーンは選ばない／persona は routed な `/v1/messages` の全出口に付き、passthrough 面には付かない |
| `tier-fixture.ts` | 上記と parity テストが DB 無しでティアマップを seed する fixture。`route(provider, tier, model)` がエイリアスで解決済みのルートを作り（model が null ならエイリアス未設定）、`__setTierProfilesForTests` に渡す |
| `tier-router/select.test.ts` | 純関数のセレクタ `selectTierRoute`。マップの順で最初に通ったものが primary で残りが fallback／ルート無し・OFF だけなら passthrough／exhaustion が 1 つでもあれば（拒否と並んでも）exhausted／error rate はサンプル数が揃ってから数える／設定済みだがこのリクエストを受けられなければ理由付きで refused／全ルートの window を超えるプロンプトは refused で、window 不明は信用する／Web 検索はツールを持つリクエストにだけ効く |
| `scenario-router.test.ts` | ティアマップ周りの部品。`requestedTierOf`（モデル名のファミリを大小文字無視で読み、`fable` が `opus` に勝ち、Claude 以外や名前無しは `other`）、`subscriptionKindOf`（429 をどのベンダの窓に付けるか）、`routeRequest` を通したサブエージェントタグ — 記録・除去されるがレーンは選ばず値も読まない、ルートが無いときも passthrough 面でも除去・記録される、閉じていないタグは存在扱いで残す、第 2 system ブロック以外・単一ブロックの system では印にならない |
| `openai-surface-signals.test.ts` | OpenAI 形の生の body から routing signal（tokenize / webSearch — ルーターが読むのはこの 2 つだけ）を読むこと。そのうちティアマップが使う 2 つがゲートに効くこと — web_search（関数名 `web_search`・`web_search_options`・hosted tool）はそれを運べないルートを飛ばし、どのルートも運べなければ拒否、長い `input` やツール定義は context ゲートに効き、どのルートにも入らなければ拒否 |
| `subagent-tag.test.ts` | `stripSubagentTag` がタグの**有無**を返すこと（値は読まない）、閉じたタグを in-place で除去すること、閉じていないタグは存在扱いで残すこと、旧綴り `<CCR-SUBAGENT-MODEL>` も受理すること。タグはもうレーンを選ばない（ティアマップにレーンは無い） |
| `tokenizers/tool-result-image.test.ts` | `tool_result` に入れ子になった image が base64 長ではなくテキスト分として数えられること（tiktoken / huggingface 両方） |
| `provider-registry-chain.test.ts` | `apiStyle` + `authMode` からの chain 導出と、chain 無しプロバイダの登録拒否 |
| `sse-aggregate.test.ts` | 4 つのワイヤ語彙それぞれの SSE→JSON 畳み込みと、その手前のガード（`findSseStreamDefect`）— 使えるイベントが 0 のストリームと上流エラーイベントを畳まず拒否し、単に途中で切れただけのストリームは従来どおり畳むこと |
| `codex-stream-failure.test.ts` | 200 を返した後の Codex ストリームで `response.failed` / `error` / `response.incomplete` が来たとき、`/v1/messages` には上流のメッセージを持つ Anthropic の `error` イベントが 1 つだけ届き（後ろに `message_stop` を付けない）、非ストリームの再試行ではエラーコードに応じた 400 / 429 / 529 / 502 になること。`max_output_tokens` での incomplete は `max_tokens` で終わる通常のメッセージになること。`message_start` の無いストリームは `message_delta` + `message_stop` の 2 イベントではなく 0 イベントで閉じること |
| `tool-result-images.test.ts` | `tool_result` の画像が base64 テキストにならないこと。unified では image part のまま保ち、Responses（Codex）では `function_call_output.output` の `input_image` 配列、Chat Completions と Gemini では tool メッセージ群の直後の user メッセージへ移すこと。テキストだけの配列は JSON ではなくテキストそのものになること |
| `bypass-header-strip.test.ts` | bypass 時の hop-by-hop ヘッダ除去 |
| `session-id.test.ts` | `thread_id` / `x-claude-code-session-id` / ランダム UUID の解決順 |
| `persona-inbound-gate.test.ts` | ペルソナ挿入が `/v1/messages` **だけ**で走ること（routed な面で `routeRequest` を直接呼び、OpenAI 形の面では `body.system` に触らないこと） |
| `openai-bypass-routing.test.ts` | passthrough 面（`/v1/chat/completions` / `/v1/responses`）ではティアマップを通らず `body.model` がそのまま残ること、routed な `/v1/messages` と `inboundPath` の無い旧呼び出しはマップを通ること（トークン数が付き、model が書き換わる） |
| `openai-responses-*.test.ts` / `anthropic-response-to-chat.test.ts` / `gemini-*.test.ts` / `response-format-converter.test.ts` | 各ワイヤ形式の双方向変換とストリーム |
| `claude-code-oauth-nonbypass.test.ts` | OAuth chain が bypass に落ちない経路 |
| `transformers/*.test.ts` | 各 transformer のリクエスト整形と OAuth 基底 |

### `__tests__/services` — サービス層

| ファイル | 担保しているもの |
|---|---|
| `config/envelope.test.ts` | `config.json` の JSON/JSON5 読込、環境変数展開、`process.env` 反映 |
| `config/migrate-home-dir.test.ts` | 旧 HOME_DIR からのコピー → 検証 → 旧削除。冪等性と、検証失敗時に原本を残すこと |
| `config/log-dir-lazy.test.ts` | ログディレクトリの遅延作成（`migrateHomeDir` より先に作らせない） |
| `failover-state.test.ts` | 枯渇マークとその失効。モデル単位のマークは同 provider の他モデルを塞がず、provider 単位のマークは全モデルを塞ぐこと、`clear*` が即座に外すこと（モデルのマークを外しても provider のマークは残る）、`modelMarksFor` が 1 provider の生きたモデルマークだけを列挙すること |
| `session-account-router.test.ts` | ハードリミット除外 → sticky → balancingScore の 4 段 |
| `usage-headroom.test.ts` | `drainTarget` / `getKindWindowHeadroom` の算術。**src に呼び出し元の無い関数のテスト**（`usage-service.ts` が再 export しているだけで、ルーティング経路からは呼ばれない） |
| `usage-fetch-force.test.ts` | usage 取得の `forceRefresh`（TTL 内のキャッシュを迂回して上流を呼び、再キャッシュする）と `enabledProvidersOnly`。既定の経路が変わらずキャッシュを返し、失敗時は直前の値を残してアカウントを `failed` に名指しすること。5h が 100 % でも 7d / Fable は上流の値とリセットのまま返すこと（100 % 扱いはスケジューラだけの話） |
| `model-test/subscription-probe.test.ts` | Codex サブスクの Test が、プロキシと同じ `openai-responses` → `codex-oauth` で request を組むこと。ChatGPT バックエンドが拒否する `max_output_tokens` を送らない、`messages` を残さない、`/responses` へ account id と `originator` 付きで送る |
| `model-test/probes.test.ts` | api_key の Responses 疎通確認は `max_output_tokens: 16` を送り続けること（公開 Responses API は 16 未満を 400 にする）。Codex 側と取り違えて「直さない」ための対 |
| `subscription-account-sync-service.test.ts` / `subscription-account-sync/crypto.test.ts` | サブアカウント同期と `RIALTO_ACCOUNT_ENCRYPTION_KEY` による暗号化 |
| `codex-auth.test.ts` | Codex のトークンリフレッシュ |
| `plan-tier-routes.test.ts` | 旧チェーン → ティアマップの planner（純関数、DB 無し）を決定ごとに。Sonnet だけのチェーンで「下げのみ」なら Haiku は Sonnet が担い続けること（P0-1 の nearest）、`tierFallback: 'refuse'` なら拒否されていたルートを OFF のまま残すこと、フォールバックは近い tier・同距離なら安い側から、同じ provider・tier の 2 モデルは 1 本のルートになること、Claude のファミリ名を持たないモデルは担っていた tier のエイリアスにすること、既存のエイリアスは上書きせずモデルの変化をメモに残すこと、エイリアスは OFF のものより配信できるモデルが先に取ること、OFF の entry は OFF のルートになること、後から来た有効な重複が先の OFF のルートを救うこと、変換しないレーンの件数をメモに残すこと |
| `cost-service.test.ts` | `computeCosts` が cache write を TTL で分けて値付けすること — 5 分は入力単価の 1.25 倍、1 時間は 2 倍。`cacheWrite1hTokens` は `cacheWriteTokens` の内訳なので足さずに割ること、内訳が総量を超えたら総量で切ること、価格の無いモデルは価格無しのまま |
| `codex-reset-service.test.ts` | Codex のバンク済みリセット（上流はスタブ、クレジット一覧は実レスポンスの fixture）。使えるのは available かつプランが対応するクレジットで、失効の近い順に並ぶこと、消費はそのクレジットを冪等キー付きで送り、返す前に使用量を取り直して routing に反映させること、ベンダの拒否は 409（取り直さない）、ベンダ障害は 502、Claude のアカウントは何も送らずに拒否、ルートがサービスのステータスで答えること |
| `routing-scheduler/collector.test.ts` | 上流の使用量（Claude の 5h / 7d / per-model、Codex の primary / secondary）を `SubAccountQuota` の窓へ写すこと。Codex は上流の `window_seconds` を保ち（Claude は固定長）、読めない `resetsAt` は null にする |
| `routing-scheduler/model-health.test.ts` | ルートの error-rate ゲートが読むリング。5 分窓の失敗率とサンプル数、古いイベントの追い出し、target ごとの分離 |
| `routing-scheduler/targets.test.ts` | quota snapshot が target 1 つについて言うこと（`targetQuotaOf` / `soonestResetOf`）。`exhausted` はティアルーターがルートを無条件に止める唯一の読みなので「その model の後ろの全アカウントがいま使い切っている」以外では立てないこと — 片方に余裕がある・未取得や古い読みのアカウントが混ざる・アカウントが無いなら開いたまま。Fable は自分の週次窓を読み、使い切っても Sonnet の予算には響かないこと |
| `routing-scheduler/tick-targets.test.ts` | tick が quota を出す target は有効なサブスクプロバイダの有効なモデルすべてで、api_key プロバイダの分は出さないこと（旧実装は `live` のチェーンだけで、他のプロファイルのルートは quota で守られていなかった）、使い切った週次窓がリセットまで target を止めること |
| `routing-scheduler/tick-concurrency.test.ts` | tick が重ならないこと。同時に頼まれた 2 回は 1 回になり、実行中の republish はそれを待ってもう 1 回だけ走らせ（合流すると書き込み前の読みを公開してしまうため）、何も走っていなければ自分で 1 回走らせること |
| `routing-scheduler/account-limit.test.ts` | quota snapshot を作る前に、5h か 7d（codex は primary / secondary）が 100 % に達した account の残りの窓を 100 %・到達した窓のうち遅い方のリセットとして扱う `holdSpentAccount`。99 % では何も変えない、per-model 7d の到達は波及しない、自前でも使い切った窓がそれより後にリセットするなら自分の値を残す、上流が返していない窓は作らない |

### `__tests__/shared` — ブラウザにも載るコード

| ファイル | 担保しているもの |
|---|---|
| `transformer-chain.test.ts` | `apiStyle` × `authMode` → chain の写像。サーバとフロントが**同じ関数**を読むので、この 1 本が両方を守る |
| `constants.test.ts` | `HOME_DIR` の解決（`RIALTO_HOME_DIR` の優先） |
| `plan-capacity.test.ts` | `planCapacityWeight` の席の重み。Claude は `rate_limit_tier` から Max 5x / 20x を読み、Codex は `plan_type` の `prolite` を 5・`pro` を 20 と数える。Providers 画面の Quota 列とスケジューラのプール予算が同じ関数を読むので、この 1 本が両方を守る |
| `plan-label.test.ts` | プランの表示名。Claude は `rate_limit_tier` から「Max 5x」/「Max 20x」、基本プランは「Pro」。Codex は `plan_type` の `prolite` を「Pro 5x」、`pro` を「Pro 20x」、基本プランは「Plus」。Activity → Usage がアカウントごとに出す名前 |

### `__tests__/parity` — 面ごとの挙動パリティ

4 つの受け口が同じ振る舞いをすることを、面をまたいだマトリクスで確認する。軸ごとの実体が
`streaming` / `non-stream-aggregate` / `tool-use` / `thinking` / `image-input` /
`system-prompt` / `cache-tokens` / `usage-record` / `error-envelope` / `failover-429` /
`routing-mode` / `gemini-request-conversion` の各ファイル。`routing-mode` は
`__setTierProfilesForTests` でティアマップを seed して routed / passthrough の両方を 4 面で確かめ、
4 つの語彙すべてでトークン数が数えられて context ゲートが効くことも見る — seed しなければ
「マップが読めない」経路を試すことになるため。以前あった `routing-lanes`（各面から think /
webSearch レーンに届くこと）は、ティアマップへの移行でレーンが無くなったので削除された。

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
| `scenarios.test.ts` | シナリオ横断のフィクスチャ |
| `fixture-schemas.test.ts` | フィクスチャ自体がスキーマに合っていること |
| `fixtures.ts` / `helpers.ts` | Rialto API 呼び出し、SSE パーサ、モデル行列取得 |

フィクスチャの取り直しは `scripts/capture-fixtures.ts`。

### `__tests__/preset`

| ファイル | 担保しているもの |
|---|---|
| `schema.test.ts` | `src/schemas/domain/preset.ts` の `JsonValueSchema` / `JsonObjectSchema` |

`JsonValueSchema` は `schemas/api/config.ts` と `schemas/domain/config.ts` の `.catchall`
（および `StatusLine` の型）を支えているので、これは**本番経路のテスト**である。
`JsonObjectSchema` の方はこのテスト以外に読み手がいない。

かつてここにあった manifest スキーマ（`PresetFileSchema` / `PresetMetadataSchema` /
`ConditionSchema`）と条件評価のテストは、対象のコードごと削除された。**ファイルのパスは
変えていない**ので `bun run test` のグロブ（`__tests__/preset`）はそのままで正しい。

「preset」と呼ばれる機能はもう無い（`RoutingPreset` も、Settings → Presets も、
`src/lib/presets/` も）。経緯は `CLAUDE.md` の `## Presets` にある。

## 未カバー領域

| 領域 | 状況 |
|---|---|
| UI コンポーネントのレンダリング | ロジックは `__tests__/lib/rialto/` で切り出してテストしているが、レンダリング自体は `ui-mock-diff` スキルのスクリーンショット差分に委ねている |
| Redis / BullMQ ジョブ | 起動が fire-and-forget なので、ジョブ本体の統合テストは無い |

## 関連

- `.claude/skills/ui-mock-diff/SKILL.md` — UI のスクリーンショット差分ワークフロー
- `docs/architecture/pipeline-overview.md` — テストが守っている実装の全体像
- [`docs/architecture/routing.md`](./routing.md) — ティアマップ。`route-request` / `tier-router/select` が守っている契約の出どころ
