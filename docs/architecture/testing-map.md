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
| `config-salvage.test.ts` | 壊れた `config.json` から `APIKEY` / `Personas` を救い出す経路 |
| `cloudflare-access.test.ts` | Access assertion の検証（署名 + audience） |
| `explain-rule.test.ts` | ルール述語の判定理由（Rule Tester 画面が読む `ConditionVerdict`） |
| `flatten-nested-router.test.ts` | ネストした Router 設定 → ランタイムのフラット形 |
| `long-context-beta.test.ts` | `context-1m-*` beta ヘッダの取り回し |
| `message-content.test.ts` | メッセージ本文の正規化 |
| `models-build-rows.test.ts` | Providers 画面のモデル行の組み立て |
| `persona-clear.test.ts` | 「ペルソナ無し」への戻し方（null / 空文字 / 欠落） |
| `preference-router-schema.test.ts` | 選好ルーターのスキーマ契約 |
| `thinking-signature-filter.test.ts` | `rialto_` プレフィクスの thinking signature 濾過 |
| `update-check.test.ts` | 更新チェック: バージョン比較（`v` 付きタグ・prerelease・読めないタグ）と、取得失敗を「最新です」に畳まないこと、成功だけをキャッシュすること |
| `preset-form-logic.test.ts` | `src/lib/presets/form-logic.ts` の `evaluateCondition` とフィールドバリデータ（Presets 画面の required-input フォームを駆動する） |
| `rialto/format.test.ts` | 表示フォーマッタ（金額の有効数字など） |
| `rialto/redact-tool-arguments.test.ts` | `REDACT_TOOL_ARGUMENTS` の除去処理 |
| `rialto/settings/access-config.test.ts`<br/>`rialto/settings/access-tokens.test.ts`<br/>`rialto/settings/envelope.test.ts` | Settings 画面の各フォームのロジック |
| `rialto/settings-content/persona.test.ts`<br/>`rialto/settings-content/presets.test.ts`<br/>`rialto/settings-content/statusline.test.ts` | Settings のサブ画面のロジック |
| `routing-map/build-graph.test.ts`<br/>`routing-map/edit-actions.test.ts` | Routing → Map のグラフ構築と編集操作 |

### `__tests__/db` — DB を張った統合テスト

`TEST_DATABASE_URL` が無ければ丸ごと skip する。`bun run test` の対象。

| ファイル | 担保しているもの |
|---|---|
| `config-service.test.ts` | `applyUiConfig` / `composeUiConfig` の往復整合、Provider/Model 削除時の RouterSlot 整合、警告、永続化 |
| `upsert-provider.test.ts` | Provider の upsert（重複名・モデル差分） |
| `access-token-service.test.ts` | トークンの発行・解決・失効。保存は sha256 のみ |
| `inbound-surface-service.test.ts` | 面ごとの `routingMode` / `profileKey` の解決と `ensureInboundSurfaces` の冪等性 |
| `passthrough-profile.test.ts` | passthrough 面のプロファイル解決 |
| `overview-service.test.ts` | Overview 画面の集計クエリ |
| `storage-service.test.ts` | ストレージ使用量の集計 |
| `helpers.ts` | DB 初期化／クリーンアップ、DB 利用可否ゲート |

### `__tests__/api` — HTTP 契約

| ファイル | 担保しているもの |
|---|---|
| `health.test.ts` | `/health` が APIKEY ゲートの外にあること、db / redis の両チェックを報告すること、`summarizeHealth` の切り分け（必須依存の失敗だけが 503。redis 落ちは degraded だが 200）、Redis プローブが未設定なら `skip`・到達不能なら hang せず `fail` |
| `local-access.test.ts` | ローカルブラウザ免除の判定（トンネル背後で常に loopback に見える問題込み） |
| `openai-bearer-auth.test.ts` | OpenAI 面が Bearer のみを受けること |
| `google-surface-auth.test.ts` | Gemini 面の `x-goog-api-key` / `?key=` |
| `request-log-events-auth.test.ts` | EventSource 用の `apikey` クエリ例外が**この 1 パスだけ**であること |
| `error-shape.test.ts` | 3 種のエラー封筒の出し分け |
| `upstream-error.test.ts` | `PROVIDER_ERR_RE` の逆パースと verbatim 転送 |
| `route-plan.test.ts` | `buildRoutePlan`（body parse、面解決、transformer 引き当て） |
| `candidate-chain.test.ts` | `buildFailoverChain` の auth_mode ゲート・同 provider drop・重複排除 |
| `cross-provider-fallback.test.ts` | ピア注入の範囲・順序・重複排除・ゲートバイパス |
| `openai-models.test.ts` | `GET /v1/models` の envelope と `provider,model` id |
| `access-log-request-id.test.ts` | アクセスログの `reqId` |
| `oauth-export-credentials.test.ts` | 認証情報エクスポート |
| `routing-scheduler-state.test.ts` / `solver-input.test.ts` | スケジューラ状態とソルバ入力の API |

### `__tests__/llms` — ルーティングと変換

| ファイル | 担保しているもの |
|---|---|
| `inbound-surfaces.test.ts` | 面レジストリ。登録済み transformer 全件について「旧分岐が返す関数 === 記述子の `aggregateSse`」を突き合わせる |
| `scenario-router.test.ts` | シナリオ分類とレーン選択 |
| `subagent-tag.test.ts` | タグの**有無**でレーンが決まること、タグが in-place で除去されること、旧綴りも受理されること |
| `peer-fallback.test.ts` | 同一モデルのピア展開 |
| `provider-registry-chain.test.ts` | `apiStyle` + `authMode` からの chain 導出と、chain 無しプロバイダの登録拒否 |
| `sse-aggregate.test.ts` | 4 つのワイヤ語彙それぞれの SSE→JSON 畳み込み |
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
| `subscription-account-sync-service.test.ts` / `subscription-account-sync/crypto.test.ts` | サブアカウント同期と `RIALTO_ACCOUNT_ENCRYPTION_KEY` による暗号化 |
| `codex-auth.test.ts` | Codex のトークンリフレッシュ |
| `router-preference-service.test.ts` / `router-utilization-service.test.ts` | 選好チェーンと利用率 |
| `routing-scheduler/{collector,compute,model-health,pace,rollout}.test.ts` | quota-aware スケジューラ |
| `solver/collect-input.test.ts` | ソルバ入力の収集 |

### `__tests__/shared` — ブラウザにも載るコード

| ファイル | 担保しているもの |
|---|---|
| `transformer-chain.test.ts` | `apiStyle` × `authMode` → chain の写像。サーバとフロントが**同じ関数**を読むので、この 1 本が両方を守る |
| `constants.test.ts` | `HOME_DIR` の解決（`RIALTO_HOME_DIR` の優先） |

### `__tests__/parity` — 面ごとの挙動パリティ

4 つの受け口が同じ振る舞いをすることを、面をまたいだマトリクスで確認する。軸ごとの実体が
`streaming` / `non-stream-aggregate` / `tool-use` / `thinking` / `image-input` /
`system-prompt` / `cache-tokens` / `usage-record` / `error-envelope` / `failover-429` /
`routing-mode` / `gemini-request-conversion` の各ファイル。

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
`ConditionSchema`）と条件評価のテストは、対象だった `src/shared/preset/` が
`src/lib/presets/form-logic.ts` の死んだ双子だったため削除され、条件評価のカバレッジは
生きている側の `__tests__/lib/preset-form-logic.test.ts` へ移った。**ファイルのパスは
変えていない**ので `bun run test` のグロブ（`__tests__/preset`）はそのままで正しい。

UI の Settings → Presets が扱うライブな `RoutingPreset` 機能とは**別物**なので混同しないこと。
「preset」と呼ばれるものの整理は `CLAUDE.md` の `## Presets` にある。

## 未カバー領域

| 領域 | 状況 |
|---|---|
| UI コンポーネントのレンダリング | ロジックは `__tests__/lib/rialto/` で切り出してテストしているが、レンダリング自体は `ui-mock-diff` スキルのスクリーンショット差分に委ねている |
| `custom-router` | ランタイムの読み手が無いので、テストする対象が無い |
| Redis / BullMQ ジョブ | 起動が fire-and-forget なので、ジョブ本体の統合テストは無い |

## 関連

- `.claude/skills/ui-mock-diff/SKILL.md` — UI のスクリーンショット差分ワークフロー
- `docs/architecture/pipeline-overview.md` — テストが守っている実装の全体像
