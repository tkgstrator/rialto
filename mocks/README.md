# UI mocks

Rialto の新UIの静的モック。**実装前の人間レビュー用**で、承認後はReact実装のターゲットになる。

計画上の位置づけは `docs/plan/rialto/master-plan.md` §5 Phase 5。

## 見る

```bash
bun run mocks:serve
```

→ http://localhost:16176/mocks/index.html

CSSのビルドとファイル監視込みなので、これ1つでよい。モックを編集すると自動で再ビルドされる
（ブラウザはリロードする）。ポートは `--port` か `MOCKS_PORT` で変えられる。

アプリの dev サーバー（:16175）とは別プロセス。あちらには一切触らない。

**サーバーを使わない場合**: `bun run mocks:css` のあと `mocks/index.html` を直接開く。
`file://` で完結し、CDN も不要。サーバー経由とレンダリングは**ピクセル単位で同一**であることを
`mocks:diff` で確認済み。スクリーンショット撮影が `file://` を使うのはこのため（サーバー不要で
CI でも動く）。

### テーマ

- 初期値は**OSの設定**（`prefers-color-scheme`）に従う
- `index.html` 上部のボタン、または各画面のサイドバー下部の **Theme** で切り替えられる
- 選択は `localStorage`（`rialto-mock-theme`）に保存され、**全画面に引き継がれる**
- `shell.js` を `<head>` から読んでいるので、ページ遷移時に light がちらつかない

スクリーンショット撮影には影響しない。`shell.js` は読み込み時に storage を**読むだけ**で、
書き込むのはユーザーが明示的に切り替えたときのみ。撮影はテーマごとに新しいブラウザコンテキスト
（storage は空）を開き、`shoot.ts` が読み込み後にクラスを明示指定するので、常に決定的になる。

### サーバーの公開範囲

リポジトリルートを起点にしているが、配信するのは以下の3つのプレフィックスだけで、それ以外は
404 になる。`.env` などのルート直下のファイルやソースツリーは配信されない。

```
mocks/
node_modules/@fontsource-variable/
node_modules/remixicon/
```

## なぜモックが実装ターゲットになるか

`_shared/mock.css` はプロジェクト本体と**同じ Tailwind**（`@tailwindcss/node` + oxide スキャナ）でコンパイルされ、
`src/index.css` の `:root` / `.dark` トークンブロックを**逐語コピー**している。ずれた状態でビルド
しようとすると `mocks:css` が失敗する。フォント（Inter / Geist Mono）とアイコン（Remix Icon）も
`node_modules` から同じ実体を読む。

したがってモックと React 実装のスクリーンショットに差が出たら、それはツールチェーンの差ではなく
**デザインの差**である。この前提の上で `ui-mock-diff` スキルが差分を測る。

## 画面

既存の22ルート + ダイアログ群を、5つのトップレベル画面に集約する（Login は Cloudflare Access に置換のため削除）。下表の「統合元」が空でない
ものは、既存コンポーネントを吸収したビュー。

### Top level

| ファイル | ビュー | 統合元 |
|---|---|---|
| `overview.html` | Overview | 新規 |

### Routing

| ファイル | ビュー | 統合元 |
|---|---|---|
| `routing.html` | Chain | RouterPreferences / TierEditor / RouterUtilization |
| `routing-passthrough.html` | Chain (passthrough) | — |
| `routing-map.html` | Map | RoutingLibrary / RoutingLiveEditor / RoutingPresetEditor |
| `routing-rules.html` | Rules | routing-map/RuleEditor |

### Providers

| ファイル | ビュー | 統合元 |
|---|---|---|
| `providers.html` | Subscription | Providers / Subscriptions / ModelsDashboard / Transformers / catalog |
| `providers-apikey.html` | API key | EditProviderDialog / ApiKeyModelsSection |
| `providers-connect.html` | Add provider | ConnectChoiceDialog / ProviderConnectFlow / ImportCredentialsDialog / ManualCallbackDialog / ManageProvidersDialog |
| `providers-connect-models.html` | Add provider 3/3 | ConnectModelsStep |

### Activity

| ファイル | ビュー | 統合元 |
|---|---|---|
| `activity.html` | Sessions | Sessions / Usage / ApiCost |
| `activity-requests.html` | Requests | RequestHistoryDrawer / usage/ModelRoutingSection |
| `activity-usage.html` | Usage | Usage / ApiCost の時系列部分 |
| `activity-session.html` | Session detail | SessionDetail |
| `activity-logs.html` | Logs | LogViewer / LogFileList / Breadcrumbs / RequestGroupList / LogEditor |

### Settings

| ファイル | ビュー | 統合元 |
|---|---|---|
| `settings.html` | Server | SettingsPage |
| `settings-access.html` | Access | 新規（Phase 3.5） |
| `settings-logging.html` | Logging | SettingsPage の一部 |
| `settings-personas.html` | Personas | Personas / PersonaView / PersonaEdit |
| `settings-statusline.html` | Status line | StatusLineConfigDialog + 6コンポーネント |
| `settings-advanced.html` | Advanced | DebugPage / JsonEditor |
| `settings-advanced-health.html` | Advanced — Health | HealthPanel |
| `settings-advanced-scratchpad.html` | Advanced — Scratchpad | ScratchpadPanel |

### Navigation（提案・未採用）

「サイドバー + セクションレール」で**縦メニューが二重**になっている問題への4案。
`shell.js` の `navMode` を切り替えているだけで、中身は既存画面と同じもの。比較用なので
`mocks.json` の `route` は `null`。

> **D を全画面に採用済み**。Settings の13remレールと、Routing / Activity のタブ列は
> 撤去され、サブビューはサイドバーのツリーに入った。`navMode: 'cloudflare'` と
> `sub` を渡すだけで、シェルの形はどの画面でも同じ。A / B / C のモックは
> 比較用に残してある（採用案が固まったら消してよい）。

| ファイル | 案 | サイドバー | 何が変わるか |
|---|---|---|---|
| `nav-accordion.html` | A | アクティブなセクションが中で開く | Settings のレールが消える。Routing / Activity のタブは残す |
| `nav-drilldown.html` | B | セクションの項目に差し替わる | 本文が最も広い。他4セクションは画面から消える |
| `nav-tree.html` | C | Aを全セクションに適用 | タブ列も無くなり、ナビはサイドバー1本になる |
| `nav-cloudflare.html` | D | Cloudflare ダッシュボードの形 | C + 上部の検索 + 複数グループ同時展開。幅16rem |

A / B / D は同じ画面（Settings › Server）で描いてあるので直接比較できる。C だけ
Activity › Requests なのは、Settings 画面では A と絵が同じになるため。

サイドバーの実装は `shell.js` の `navMode` 1つ（`flat` / `accordion` / `drilldown` / `tree` /
`cloudflare`）。サブビューの定義は `SUBNAV` に1箇所だけあるので、採用案が決まれば
既存画面は `navMode` を渡すだけで移行できる。

### System（アプリシェル無し）

ログイン画面は無い。管理UIは **Cloudflare Access** がエッジで認証するので、アプリはフォームを
描画しない（計画書 §Phase 3.5）。

| ファイル | ビュー | 統合元 |
|---|---|---|
| `setup.html` | First run | SetupDialog |
| `system-states.html` | System states | OauthResultPage / ErrorPage / Login |

`routing.html` と `routing-passthrough.html` が今回のリファクタの核心。最上位の軸が
**inbound面**（`/v1/messages` / `/v1/chat/completions` / `/v1/responses` / `/v1beta/models/*`）
になっていて、面ごとに routed / passthrough を切り替えられる。現状のコードはこの切り替えが
`scenario-router.ts:117-128` にハードコードされていて、UIからは見えない。

## 構成

```
mocks/
  index.html              レビュー用の入口
  <screen>.html           各画面。file:// で直接開ける
  mocks.json              画面レジストリ（モックファイル ↔ Reactルート）
  _shared/
    shell.js              サイドバー/ヘッダーと共通プリミティブ（classicスクリプト）
    mock.css              Tailwindエントリ。トークンは src/index.css のコピー
    mock.build.css        生成物。手で触らない
  .shots/                 スクショ・差分・report.json（生成物）

scripts/
  build-mock-css.ts       bun run mocks:css
  serve-mocks.ts          bun run mocks:serve
```

`shell.js` が ES module ではなく classic script なのは、`file://` の Chrome が
origin `null` からの module import をCORSで弾くため。すべて `window.Shell` にぶら下げている。

## 文字の段

サイズは**3段だけ**で、それぞれ仕事が1つ:

| | 用途 |
|---|---|
| **14px** (`text-sm`) | アプリのクローム（サイドバー・パンくず）と、**本文のセクション見出し**（通常表記・semibold） |
| **12px** (`text-xs`) | 本文（表のセル・フィールドラベル・値・ボタン） |
| **11px** (`text-[11px]`) | **固定ペイン/レールの札**と**表の列見出し**（小文字キャップス）、および二次テキスト・mono のメタ |

見出しが2種類あるのは**格が違う**からで、書式で見分ける:

- **本文のセクション** = スクロールする中身の一区切り → 14px 通常表記
  （`Inbound surfaces` `Models` `Credentials` `Required inputs` `Checks`）
- **固定ペイン/レールの札** = いつもそこにある列の名前 → 11px 大文字
  （`ADD MODULE` `LINE` `FILES` `VENDOR` `SUMMARY` `CONSTRAINTS` `SUBSCRIPTIONS`）

札を本文より小さくするのは、読むのが最初の1回だけの道標だから。表の列見出しと同じ family に
なるので、キャップスを見たら「位置を示すもの」と読める。

9-10px はチャート内部のラベル3箇所のみ（プロットを詰まらせない別の都合がある）。

## 導線

IAのレビューは「画面がどう見えるか」だけでは足りず、**画面から画面へどう辿り着くか**を
実際に歩けないと判断できない。そのため、他の画面を指している要素はすべて遷移する:

- テーブルの行（セッション → セッション詳細、リクエスト → そのログ、チェーン行 → プロバイダ）
- 統計タイル・カード・グラフのノード
- ヘッダーのアクションで他画面を名指しするもの（Live map / Add provider / Manage tokens / Open in Activity …）

仕組みは `data-nav="<file>.html"` 属性1つと `shell.js` の委譲リスナー。`<a>` で包まないのは、
いちばん遷移させたい要素が包めないため — `<tr>` は `<a>` を持てないし、行の中に自前のトグルや
`⋯` ボタンを抱えている行も多い。そういう内側のコントロールを押したときは、行の遷移は起きない。

`data-nav` は**モック専用**の属性で、Reactの実装側には存在しない。カーソル形状は
`mock.css` の 1ルールだけで、スクリーンショットには写らない — つまりこの仕組みは
`mocks:diff` の数字を1ピクセルも動かさない。

グループ内のタブ（Activity の4本、Routing の3本）と Providers のレールは `shell.js` に
1箇所だけ定義がある。画面ごとにインラインで持っていたときは、Usage タブが1画面にしか
無いといった食い違いが起きていた。

## 実装フェーズでの使い方

`mocks.json` の `route` を `null` から実際のReactルートに変えてから:

```bash
bun run mocks:shoot     # 両サイドをRetina(=@2x)で撮影
bun run mocks:diff      # ピクセル差分 + report.json
```

詳細は `.claude/skills/ui-mock-diff/SKILL.md`。

## 制約

- データはすべてダミー。フォームと編集操作は動かない
- **画面間の遷移は動く** — サイドバー、設定レール、タブに加えて、**行・タイル・カード・ヘッダーの
  アクションも実際に遷移する**。テーマ切り替えも動く
- レスポンシブは未検討。1440×900 固定で設計している
- i18n未適用（英語ハードコード）。キー再編は実装フェーズで行う
