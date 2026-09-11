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
| `chain-target-state.test.ts` | Routing 画面のチェーン行で、スケジューラが測れなかった target（api_key など）の重みをどう見せるか |
| `routing-constraints.test.ts` | Routing 画面の制約セル。未保存の blob がスキーマのデフォルトとして読めること、編集が画面に出ていないキー（`longContextThreshold` など）を残してマージされること、デフォルトと同じ値の書き込みを変更扱いしないこと、Quota skip が 0〜100 の整数だけ通ること |
| `long-context-beta.test.ts` | `context-1m-*` beta ヘッダの取り回し |
| `message-content.test.ts` | メッセージ本文の正規化 |
| `models-build-rows.test.ts` | Providers 画面のモデル行の組み立て |
| `passthrough-denial.test.ts` | passthrough 面の `deniedTargets`。routed な面では判定しないこと（`body.model` は chain が置き換え済み） |
| `persona-clear.test.ts` | 「ペルソナ無し」への戻し方（トップレベル `ActivePersona` の null / 空文字 / 欠落） |
| `preference-router-schema.test.ts` | 選好ルーターのスキーマ契約 |
| `provider-routable.test.ts` | `Provider.enabled` を Routing が絞る集合と Providers 画面の表示が一致すること |
| `thinking-signature-filter.test.ts` | `rialto_` プレフィクスの thinking signature 濾過 |
| `update-check.test.ts` | 更新チェック: バージョン比較（`v` 付きタグ・prerelease・読めないタグ）と、取得失敗を「最新です」に畳まないこと、成功だけをキャッシュすること |
| `rialto/format.test.ts` | 表示フォーマッタ（金額の有効数字など） |
| `rialto/provider-draft.test.ts` | プロバイダ詳細の Edit → Save が書くもの。手で元に戻した変更は何も書かないこと、プロバイダ・モデルのスイッチとキーは読み込んだ行を土台にした 1 回の upsert に載り、tier / effort は変わったものだけが個別の書き込みになること（upsert には載せない） |
| `rialto/redact-tool-arguments.test.ts` | `REDACT_TOOL_ARGUMENTS` の除去処理 |
| `rialto/settings/access-config.test.ts`<br/>`rialto/settings/access-tokens.test.ts`<br/>`rialto/settings/envelope.test.ts` | Settings 画面の各フォームのロジック |
| `rialto/settings-content/persona.test.ts`<br/>`rialto/settings-content/statusline.test.ts` | Settings のサブ画面のロジック |

### `__tests__/db` — DB を張った統合テスト

`TEST_DATABASE_URL` が無ければ丸ごと skip する。`bun run test` の対象。

| ファイル | 担保しているもの |
|---|---|
| `config-service.test.ts` | `applyUiConfig` / `composeUiConfig` の往復整合、Provider/Model 削除で cascade するチェーン entry の警告、退役キー（`APIKEY` / `Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK`）を警告付きで捨て・ディスクから剥がし、`GET /api/config` にも出さないこと、トップレベル `ActivePersona` の往復、永続化 |
| `upsert-provider.test.ts` | Provider の upsert（重複名・モデル差分）と、Provider / Model 削除がチェーン entry を profile / scenario / lane 単位で数えて警告すること |
| `disabled-targets.test.ts` | 無効な Provider / Model がどの経路からも送られないこと — チェーン entry（`loadRoutableProfile` の折り込み）、passthrough の `provider,model`（registry に無い pair を `resolveInvocationForModel` が拒否）、bare 名の解決、サブスクリプションのアカウントプール |
| `access-token-service.test.ts` | トークンの発行・解決・失効。保存は sha256 のみ |
| `inbound-surface-service.test.ts` | 面ごとの `routingMode` / `profileKey` の解決と `ensureInboundSurfaces` の冪等性 |
| `passthrough-profile.test.ts` | passthrough 面のプロファイル解決 |
| `overview-service.test.ts` | Overview 画面の集計クエリ |
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
| `route-plan.test.ts` | `buildRoutePlan`（body parse、面解決、transformer 引き当て、chain の primary / fallbacks が plan に載ること） |
| `candidate-chain.test.ts` | `buildFailoverChain` — chain の順序をそのまま辿ること（subscription primary が api_key fallback を保つ、同 provider も通る）、重複排除、exhausted 除外と全滅時の順序維持 |
| `router-preferences.test.ts` | `constraints.longContextThreshold` の受理（正の整数か null）と `/api/router-preferences` での往復。スキーマが通さない制約 blob を PUT が拒否して何も書かないこと、通った blob をデフォルトで埋めずにそのまま保存すること |
| `chain-failover-cooldown.test.ts` | 429 後の枯渇マークと cooldown |
| `openai-models.test.ts` | `GET /v1/models` の envelope と `provider,model` id |
| `access-log-request-id.test.ts` | アクセスログの `reqId` |
| `oauth-export-credentials.test.ts` | 認証情報エクスポート |
| `oauth-import-credentials.test.ts` | 認証情報の取り込み。資格情報ファイルでない JSON と account id の無い Codex 資格情報を上流に問い合わせる前に 400 で断ること、上流が拒否した資格情報は（refresh token があれば 1 回 refresh を試したうえで）400 で断り何も書かないこと、refresh で通った場合は回転後の grant を保存すること、上流に届かなければ 502 で何も書かないこと、受理されたアカウントが `live` で保存され同じリクエスト内で `SubAccountUsage` / `SubAccountQuota` まで埋まること |
| `subscriptions-refresh.test.ts` | `POST /api/subscriptions/refresh`（Providers 画面の Refresh のアカウント側）。プロファイル再同期と 5 分キャッシュを迂回した usage 取得が `SubAccountQuota` / `SubAccountUsage` に着地し、`UsageSnapshot` には書かないこと。body 無し・`{}` では無効プロバイダのアカウントを呼ばないこと、`{ provider }` ではそのプロバイダのアカウントだけを無効化されていても同期・取得して他を呼ばないこと、subscription プロバイダに無い名前は 404 で何も呼ばないこと、失敗アカウントを名指しして行を触らないこと、同じスコープの同時呼び出しが 1 回の上流パスに合流すること、`/sync` の契約が変わらないこと |
| `routing-scheduler-state.test.ts` / `solver-input.test.ts` | スケジューラ状態とソルバ入力の API |

### `__tests__/llms` — ルーティングと変換

| ファイル | 担保しているもの |
|---|---|
| `inbound-surfaces.test.ts` | 面レジストリ。登録済み transformer 全件について「旧分岐が返す関数 === 記述子の `aggregateSse`」を突き合わせる |
| `route-scenario-chain.test.ts` | `routeScenario` の通し契約。chain に primary があれば `body.model` と fallbacks が置き換わる／空レーン・全ゲート落ち（`exhaustedBehavior` の両値）・chain 読込失敗・例外では呼び出し側の `body.model` が触られない／`exhaustedBehavior='429'` は Retry-After を stamp して書き換えない／無効な target は primary にも fallback にもならない／token の `passthrough` profile と passthrough 面は chain を飛ばす |
| `chain-fixture.ts` | 上記と parity テストが DB 無しで chain を seed するための fixture（`__setPreferencesForTests` に渡す profile を組む） |
| `chain-scenario-gate.test.ts` | 分類がレーンの entry 有無で gate されること、`chainRoutingOf` の射影（全 OFF のレーンは未設定扱い、先頭 entry の window、constraint の threshold）、`effectiveLongContextThreshold` の解決順（constraint → window × 0.7 → 128k） |
| `scenario-router.test.ts` | `candidateUsable` / `applyProactiveFailover`（枯渇マーク・capability ゲート）/ `isHeavyRequest` / `classifyRequest` の effort・tier・thinking 分岐 |
| `openai-surface-signals.test.ts` | OpenAI 形のリクエストから routing signal（thinking / tools / トークン数）を読むこと |
| `subagent-tag.test.ts` | タグの**有無**でレーンが決まること、タグが in-place で除去されること、旧綴りも受理されること |
| `tokenizers/tool-result-image.test.ts` | `tool_result` に入れ子になった image が base64 長ではなくテキスト分として数えられること（tiktoken / huggingface 両方） |
| `provider-registry-chain.test.ts` | `apiStyle` + `authMode` からの chain 導出と、chain 無しプロバイダの登録拒否 |
| `sse-aggregate.test.ts` | 4 つのワイヤ語彙それぞれの SSE→JSON 畳み込みと、その手前のガード（`findSseStreamDefect`）— 使えるイベントが 0 のストリームと上流エラーイベントを畳まず拒否し、単に途中で切れただけのストリームは従来どおり畳むこと |
| `codex-stream-failure.test.ts` | 200 を返した後の Codex ストリームで `response.failed` / `error` / `response.incomplete` が来たとき、`/v1/messages` には上流のメッセージを持つ Anthropic の `error` イベントが 1 つだけ届き（後ろに `message_stop` を付けない）、非ストリームの再試行ではエラーコードに応じた 400 / 429 / 529 / 502 になること。`max_output_tokens` での incomplete は `max_tokens` で終わる通常のメッセージになること。`message_start` の無いストリームは `message_delta` + `message_stop` の 2 イベントではなく 0 イベントで閉じること |
| `tool-result-images.test.ts` | `tool_result` の画像が base64 テキストにならないこと。unified では image part のまま保ち、Responses（Codex）では `function_call_output.output` の `input_image` 配列、Chat Completions と Gemini では tool メッセージ群の直後の user メッセージへ移すこと。テキストだけの配列は JSON ではなくテキストそのものになること |
| `bypass-header-strip.test.ts` | bypass 時の hop-by-hop ヘッダ除去 |
| `session-id.test.ts` | `thread_id` / `x-claude-code-session-id` / ランダム UUID の解決順 |
| `persona-inbound-gate.test.ts` | ペルソナ挿入が `/v1/messages` **だけ**で走ること |
| `openai-bypass-routing.test.ts` / `openai-responses-*.test.ts` / `anthropic-response-to-chat.test.ts` / `gemini-*.test.ts` / `response-format-converter.test.ts` | 各ワイヤ形式の双方向変換とストリーム |
| `claude-code-oauth-nonbypass.test.ts` | OAuth chain が bypass に落ちない経路 |
| `quota-router/{selection,runtime,tier-shift,context-window-gate}.test.ts` | 選好ベースセレクタ |
| `transformers/*.test.ts` | 各 transformer のリクエスト整形と OAuth 基底 |

### `__tests__/services` — サービス層

| ファイル | 担保しているもの |
|---|---|
| `config/envelope.test.ts` | `config.json` の JSON/JSON5 読込、環境変数展開、`process.env` 反映 |
| `config/migrate-home-dir.test.ts` | 旧 HOME_DIR からのコピー → 検証 → 旧削除。冪等性と、検証失敗時に原本を残すこと |
| `config/log-dir-lazy.test.ts` | ログディレクトリの遅延作成（`migrateHomeDir` より先に作らせない） |
| `failover-state.test.ts` | 枯渇マークとその失効 |
| `session-account-router.test.ts` | ハードリミット除外 → sticky → balancingScore の 4 段 |
| `usage-headroom.test.ts` | `drainTarget` / `getKindWindowHeadroom` の算術。**現在のルーティング経路からは呼ばれない関数のテスト**（UI と将来の再利用のために残してある） |
| `usage-fetch-force.test.ts` | usage 取得の `forceRefresh`（TTL 内のキャッシュを迂回して上流を呼び、再キャッシュする）と `enabledProvidersOnly`。既定の経路が変わらずキャッシュを返し、失敗時は直前の値を残してアカウントを `failed` に名指しすること。5h が 100 % でも 7d / Fable は上流の値とリセットのまま返すこと（100 % 扱いはスケジューラだけの話） |
| `model-test/subscription-probe.test.ts` | Codex サブスクの Test が、プロキシと同じ `openai-responses` → `codex-oauth` で request を組むこと。ChatGPT バックエンドが拒否する `max_output_tokens` を送らない、`messages` を残さない、`/responses` へ account id と `originator` 付きで送る |
| `model-test/probes.test.ts` | api_key の Responses 疎通確認は `max_output_tokens: 16` を送り続けること（公開 Responses API は 16 未満を 400 にする）。Codex 側と取り違えて「直さない」ための対 |
| `subscription-account-sync-service.test.ts` / `subscription-account-sync/crypto.test.ts` | サブアカウント同期と `RIALTO_ACCOUNT_ENCRYPTION_KEY` による暗号化 |
| `codex-auth.test.ts` | Codex のトークンリフレッシュ |
| `router-preference-service.test.ts` / `router-utilization-service.test.ts` | 選好チェーンと利用率 |
| `routing-scheduler/{collector,compute,model-health,pace,rollout}.test.ts` | quota-aware スケジューラ |
| `routing-scheduler/account-limit.test.ts` | Chain の重みを出す前に、5h か 7d（codex は primary / secondary）が 100 % に達した account の残りの窓を 100 %・到達した窓のうち遅い方のリセットとして扱う `holdSpentAccount`。99 % では何も変えない、per-model 7d の到達は波及しない、自前でも使い切った窓がそれより後にリセットするなら自分の値を残す、上流が返していない窓は作らない |
| `solver/collect-input.test.ts` | ソルバ入力の収集 |

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
`routing-mode` / `routing-lanes` / `gemini-request-conversion` の各ファイル。`routing-mode` と
`routing-lanes` は `__setPreferencesForTests` で chain を seed して routed / passthrough の両方を
4 面で確かめる — seed しなければ「chain が読めない」経路を試すことになるため。

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
