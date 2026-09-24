# Subscription Utilization Tuning（Router 使用率の可視化と自動調整）

> **置き換え済み（2026-09）:** 本書のルーティング設計はティアマップ（要求ティア → プロバイダのティアエイリアス）に置き換えられた。現行の設計は [quota-and-tier-routing.md](./quota-and-tier-routing.md) を参照。

Status: Planning

## 目的

Router スロットに紐付いた subscription (Claude Code Pro/Max, Fable) の **枠使用率** を可視化し、**「余り」「詰まり」の両方を検出**できるようにする。将来的には枠の稼働率を維持するようルールを自動調整する余地も残す。

段階的に導入することで、**運用オペレーション上の判断** (「Fable が余ってる、どのスロットに振ろうか」) をデータドリブンに落とし込む。

## 背景 / 動機

### 症状

本番運用中の CCR ログを集計したところ、以下が判明:

| スロット | 7日 req 数 | opus/fable-tier req | 実際に Fable へ到達した req | 到達率 |
|---|---:|---:|---:|---:|
| `longContext` | 8,171 | 7,971 | **0** | 0% |
| `think` | 37,548 | 17,118 | 270 | 1.6% |
| `webSearch` | 36 | 36 | 0 | 0% |
| **合計** | 45,755 | 25,125 | **270** | **1.1%** |

**Fable subscription の稼働率がほぼ 0** の状態で、`opus-5` に大半のトラフィックが流れている。逆に以前は "Fable カツカツ" だった時期もあり、**気付かないうちに routing 設定がずれて subscription を無駄にしている** ことがある。

### 根本原因の類型

1. **スロット primary の誤配置**: そもそも Fable が primary に居ない (今回の longContext がこれ)
2. **rule 発火条件が非現実的**: `minTokens: 512000` のような Claude Code の実サイズと合わない閾値 (今回の think がこれ)
3. **subscription 枠変更への追従漏れ**: プラン変更や新モデル追加時に config が更新されない

いずれも **設定が正しいかどうかを人が能動的に確認しないと分からない** のが問題。

## スコープ / 非スコープ

### スコープ (この計画書が扱う範囲)

- Level 1: 既存 `fallbacks` チェーンでの spillover 挙動を運用ドキュメント化する
- Level 2: **使用率ダッシュボード** — 各スロットの直近利用状況を UI に表示、乖離が大きい場合は調整候補を提案
- Level 3 の**設計スケッチのみ** (実装は別 issue)

### 非スコープ

- Level 3 の完全な自走式オートチューナー実装 (リスクが高いので別途)
- subscription プランの残枠 API 統合の新規開発 (`profile-sync` の既存メカニズムで足りる範囲内)
- 他 vendor (Codex, OpenAI API) の枠管理

## 設計

### Level 1: 既存機能の活用 (追加開発 0)

CCR の `RouterSlot.params.fallbacks` は既に per-request のフォールバックチェーンを持つ (`src/llms/scenario-router/failover.ts`):

- primary が **429 / context overflow / 5xx** で失敗 → `fallbacks[0]`, `fallbacks[1]`, ... と順に試す
- `contextWindow < tokenCount` の場合、事前に fallback を選び直す

これを最大限使う設定パターン:

```jsonc
{
  "agentRules": [
    { "when": { "requestedTier": ["opus", "fable"] }, "target": "claude-code,claude-fable-5" }
  ],
  "fallbacks": ["claude-code,claude-opus-5", "claude-code,claude-opus-4-7"]
}
```

- Fable が生きてる限り Fable へ
- Fable が quota 枯渇 → opus-5 に自動退避 → さらに失敗なら opus-4-7

**運用結論**: subscription を使い切りたければ `primary = Fable, fallbacks = [opus-系]` にするだけ。追加実装不要。**運用ガイドとして docs/guides/ に一節追加**する。

### Level 2: 使用率ダッシュボード

#### データソース

既存の `RequestLog` テーブルで足りる。追加スキーマ変更不要。

- `scenario` (String?) — どのスロットで発火したか
- `provider`, `model` — 実際の送信先
- `requestedModel` — クライアントが要求したモデル
- `status`, `createdAt`, `totalInputTokens`

#### 集計指標

各 `(scenario, provider, model)` について直近 7d を集計:

1. **request 数** (n)
2. **success rate** (`status = 200` の割合)
3. **要求↔送信の乖離マトリクス** (`requestedModel` × `sent model`)
4. **token 分布** (min/p50/p75/p90/max)
5. **subscription 側の枠使用率** (既に `profile-sync` で取得している plan_type / quota 情報と突合)

#### UI 配置

Router 編集画面 (`src/components/Router*.tsx`) の各スロットに **使用率バッジ** を追加:

```
┌─ longContext ─────────────────────────────────────┐
│ primary: claude-code,claude-opus-5                │
│ ├ 7d: 8,171 req / 100% success                    │
│ └ Fable 到達率: 0%  ⚠ (subscription 未活用の疑い)│
│                                                    │
│ [Suggested: primary を claude-fable-5 に変更]     │
│ [SQL を表示] [自動適用]                            │
└────────────────────────────────────────────────────┘
```

- バッジ色: green (使用率 40-80%), yellow (>80% or <10%), red (429 多発 or 完全未使用)
- "Suggested" は Level 2 の **提案文生成ロジック** で作る (下記)

#### 提案文生成ロジック

以下の判定を per-slot で走らせる:

| 検出条件 | 提案 |
|---|---|
| primary の subscription 到達率 < 10% & fallback 到達率 > 80% | primary の見直しを提案 |
| primary の 429 rate > 5% & fallback 未設定 | fallbacks 追加を提案 |
| `minTokens` 条件のヒット率 < 5% (rule 全体で) | 閾値を p75 付近に下げる提案 |
| tier-指定モデルが同 tier のスロット target に居ない | target 修正を提案 |

提案は **表示のみ、適用は人がボタンクリック**。SQL diff もその場で見せる。

#### 実装粒度

- 新規 API: `GET /api/router-utilization` (7d 集計を返す、per scenario)
- 新規サービス: `src/services/router-utilization-service.ts`
- UI: 既存 Router 編集画面にバッジコンポーネント追加 (新規タブ不要)

推定工数: **1〜2 日**

### Level 3: 自走式オートチューナー (現行スキーマの延長)

**この計画書では実装しない**。将来の拡張として下記の輪郭だけ残す。

#### 想定挙動

- 日次で `RequestLog` + subscription 残枠を集計
- 目標利用率 (例: Fable 60〜85%) と乖離してたら `RouterSlot.params.agentRules` の `minTokens` を自動調整

#### 必須ガードレール

自動化にあたって以下を担保しないと事故る:

1. **変化率制限**: `minTokens` を一度に ±20% までしか動かさない (発振防止)
2. **上下限**: 各スロットの `minTokens` に許容レンジを設定 (例: 30k〜300k)
3. **観測窓**: 直近 24h の実データがないと調整しない (少数サンプル判断禁止)
4. **緊急ロールバック**: 直近 1h の 429 が急増 → 前回の設定に自動戻し
5. **監査ログ**: 全ての自動変更を `RouterConfigChange` (新テーブル) に記録
6. **通知**: 変更発生時に Slack/email へポスト、人がレビュー可能に
7. **kill switch**: envelope 側に `AUTO_TUNE_ENABLED` フラグ、default OFF

#### なぜ後回しか

- 自動化するとバグや不適切判定が **静かにコストを膨らませる** 危険がある
- Level 2 のダッシュボード + 人手適用で 80% の価値は取れる (実感覚)
- ユーザーが「毎晩勝手にルールが書き換わってる」を許容する運用体制になってから

### Level 4: 宣言的 Router (Preference-Based Routing)

Level 3 は **現行スキーマの `agentRules` を機械が書き換える** アプローチ。
Level 4 は **スキーマ自体を捨てて "使いたい優先度" だけを宣言する** ラディカルな再設計。

#### 問題意識

現状のスキーマは `scenario × requestedTier × minTokens × target model` の **4次元マトリクス**をユーザーが手書きする必要がある。今回のような "Fable が primary から抜けてた" 問題は、この記述の複雑さそのものが原因。

Level 3 は自動的にパラメータを補正するが、**スキーマの複雑さは残る** — つまり自動化されたロジックの中身がユーザーには見えなくなるだけで、根本原因は解消しない。

#### 宣言モデル

ユーザーは **"どのモデルをどの順で使いたいか"** だけを書く:

```jsonc
{
  "preferences": [
    { "model": "claude-code,claude-fable-5", "priority": 1 },
    { "model": "claude-code,claude-opus-5",  "priority": 2 },
    { "model": "claude-code,claude-opus-4-7", "priority": 3 },
    { "model": "claude-code,claude-sonnet-5", "priority": 4 }
  ],
  "constraints": {
    "sonnetTierRespect": true,      // sonnet 要求は sonnet 系のみ
    "haikuTierRespect": true,       // haiku 要求は sonnet 以下 (haiku はもう無い)
    "maxCostPerDay": 50             // オプション: 上限
  }
}
```

これだけで scenario / rule 一切書かなくてよい。

#### ランタイム挙動

リクエスト着信時に:

1. **選択候補の絞り込み**: リクエストの `tokenCount` + tier 要求と `constraints` に合うモデルだけ
2. **priority 昇順で試行**: 上から順に、以下の条件を満たすまで探索:
   - `contextWindow >= tokenCount` (context に収まる)
   - 直近の subscription usage が枠内 (quota-aware)
   - モデル自体が healthy (直近 5min の error rate < 20%)
3. **選ばれたモデルへ送信**: 失敗したら次候補へ (既存 fallback 相当が preference chain に自然に統合される)

**scenario 分類ロジック (`classifyScenario`) は完全に廃止**。「thinking フィールドがあるから think スロット」といった中間抽象化が消える。

#### 実現に必要な要素

| 要素 | 現状 | Level 4 で必要 |
|---|---|---|
| モデルカタログ (contextWindow, tier) | ある (`Model` テーブル) | そのまま |
| subscription usage 集計 | ある (`profile-sync` 経由) | リアルタイム化必要 |
| モデル健全性トラッキング | ある (`Model.testStatus`) | 直近 5min の error rate 集計を追加 |
| preference config スキーマ | なし | 新規 (envelope or DB) |
| ランタイムセレクタ | scenario router | 新規 preference-based selector |
| 既存 Router UI | rule editor | preference リストの drag-and-drop |

#### 移行戦略

破壊的変更なので段階的に:

1. **共存フェーズ**: `Router.preferences` が設定されていれば新セレクタ、なければ既存 scenario router (feature flag)
2. **推奨フェーズ**: UI で新設定を promote、旧設定は "Legacy" バッジ
3. **削除フェーズ**: 数バージョン後に `RouterSlot` テーブルごと廃止

推定工数: **1〜2 週間** (共存フェーズまで)、削除まで含めると数ヶ月

#### メリット / デメリット

**メリット**:
- **設定ミスが原理的に起きにくい**: 4次元マトリクスから 1次元リストへ
- **subscription 導入時のオンボーディングが即完了**: 「新しく契約したモデルを priority 1 に入れるだけ」
- **意図が明快**: 「Fable を最優先で使いたい」を config がそのまま表現できる
- Level 3 のガードレール (発振防止、変化率制限) が不要 — 順番だけなのでそもそも発振しない

**デメリット**:
- **細かい制御ができなくなる**: 例えば「短いリクエストは opus、長いのは fable」といった条件付き分岐が書けなくなる (constraints で表現するか、条件付き preference chain を許すか)
- **既存ユーザーの移行負担**: 現行 rule ベース config からの手動翻訳
- **runtime selector の複雑さが増える**: quota チェックや health チェックの遅延がリクエスト経路に載る
- **実装コスト大**: 既存の scenario router を並行運用しつつ廃止する期間が長い

#### なぜ Level 4 として別扱いか

Level 3 は既存の枠組みの **メンテナンス自動化**、Level 4 は **枠組みそのものの再設計**。破壊的変更のインパクトが桁違いなので、Level 3 の運用実績を踏まえてから判断する。

Level 4 に踏み切るトリガー例:
- Level 2 のダッシュボードで「rule 設定ミス」が頻発することが定量的に判明
- 複数 subscription を並列運用するユーザーが増え、rule ベースの負担が明らかに大きくなった
- 逆に Level 3 の自動チューニングが十分に賢く、rule の複雑さが**運用上の問題ではない**と分かれば Level 4 は不要

## マイグレーション / 後方互換

- Level 1: 変更なし (既存機能の利用)
- Level 2: `GET /api/router-utilization` の追加のみ。既存 API/DB スキーマ影響なし
- Level 3: `RouterConfigChange` テーブル追加、`AUTO_TUNE_ENABLED` envelope キー追加
- Level 4: 破壊的。`Router.preferences` 新設 + `RouterSlot` を段階的廃止。共存期間を経てスキーマ削除

## 段階的リリース

1. **Phase 1**: 運用ガイド追加 (Level 1)。今日でも書ける
2. **Phase 2**: `router-utilization-service` + API 実装
3. **Phase 3**: UI バッジ + 提案文表示 (適用ボタン付き)
4. **Phase 4** (別 issue): Level 3 の必要性を再評価。ユーザーからの要望が積み上がったら着手
5. **Phase 5** (別 issue、遠い将来): Level 4 の宣言的 Router 移行判断。Level 2/3 の運用実績が判断材料になる

Phase 2〜3 が今回の主要スコープ。Phase 4 は Level 3、Phase 5 は Level 4 に対応。

## 影響評価

### ポジティブ

- subscription の稼働率を上げてコスト最適化
- 設定ミス (今回の 512k 問題等) を早期発見
- routing の意思決定が「感覚」から「データ」ベースへ

### ネガティブ

- Level 2 の UI は情報密度が上がる → ダッシュボード疲れ、無視されるリスク
- 提案文が **常に賢いとは限らない** → 誤った提案を人が鵜呑みにする危険 (「Suggested」の文言に十分なコンテキストが必要)

## 参考 / 関連

- `src/llms/scenario-router/model-selection.ts` — 現行 classifier
- `src/llms/scenario-router/failover.ts` — 既存 fallback チェーン
- `src/services/subscription-account-sync/profile-sync.ts` — subscription 側の枠情報取得口
- 関連する既存 plan doc:
  - `docs/plan/router-force-override.md` — スロット単位の強制上書き
  - `docs/plan/rules-only-router.md` — ルールベース化の構想
