# Rules-Only Router（Primary を rules[] の catch-all に統合）

> **置き換え済み（2026-09）:** 本書のルーティング設計はティアマップ（要求ティア → プロバイダのティアエイリアス）に置き換えられた。現行の設計は [quota-and-tier-routing.md](./quota-and-tier-routing.md) を参照。

Status: Planning

## 目的

各 `(scenario, kind)` の route target から **`primary`（FK）と `fallbacks` の catch-all フィールドを廃止**し、
routing 対象は **順序付き rules[] のみ** で表現するようにデータモデルを平坦化する。

現在の `primary` は「述語なしで無条件に fire する rule」の特殊ケースにすぎない。
つまり **rules[] の末尾に置く `when: {}` の catch-all rule と等価**であり、
別フィールドとして持つ意味は「初期設定の 1 手を省く」以上にはない。

一方で `primary` を残していることが原因で:

- 「Primary と Rule で同じモデルを指せない」的な UX の歪み（v2.39.1 で patch した）
- Runtime の resolveTarget が「rules を walk → 見つからなければ primary → passthrough」の 2 段構成
- UI が「catch-all セクション + rules セクション」の 2 パネル構成
- Prisma FK による cascade 制約が rule 中の target model には及ばない、
  という **仕組みの非対称性**

を抱えている。統一するのが素直。

## 現状

### RouterSlot（Prisma）

```prisma
model RouterSlot {
  id              String       @id @default(cuid())
  scenario        ScenarioKey  @unique
  modelId         String?      // ← agent primary（FK）
  model           Model?       @relation("RouterSlotAgentModel", …, onDelete: Restrict)
  subagentModelId String?      // ← subagent primary（FK）
  subagentModel   Model?       @relation("RouterSlotSubagentModel", …, onDelete: Restrict)
  params          Json?        // { fallbacks[], subagentFallbacks[], threshold, agentRules[], subagentRules[] }
  updatedAt       DateTime     @updatedAt
}
```

### Zod（router.dto.ts）

```ts
RouteTargetSchema = z.object({
  primary: EmptyStringToNullSchema.default(null),      // ← catch-all primary
  fallbacks: z.array(FallbackEntrySchema).default([]), // ← catch-all fallback chain
  rules: z.array(RouteRuleSchema).default([])          // ← 順序付き rules
})

RouteRuleSchema = z.object({
  name: z.string().optional(),
  when: RulePredicateSchema.default({}),
  primary: EmptyStringToNullSchema.default(null),
  fallbacks: z.array(FallbackEntrySchema).default([])  // 実際は無視されている（rule には failover chain を持たせない設計）
})
```

### Runtime（model-selection.ts）

```ts
function resolveTarget(...) {
  // 1. rules を walk（first-match wins）
  for (const rule of rulesFor(router, kind, scenario)) {
    if (matchesRule(rule, ctx)) return { primary: rule.primary, fallbacks: catchAllFallbacks }
  }
  // 2. rule が誰もマッチしなかったら catch-all primary
  const primary = primaryFor(router, kind, scenario)
  if (primary === undefined) return undefined
  return { primary, fallbacks: catchAllFallbacks }
}
```

## 提案

### 新しいデータモデル

`RouteTarget` から `primary` を落とし、rules[] のみにする。fallback は scenario 共有の 1 本だけ残す。

```ts
RouteTargetSchema = z.object({
  rules: z.array(RouteRuleSchema).default([]),           // 順序付き
  fallbacks: z.array(FallbackEntrySchema).default([])    // catch-all fallback chain（rule 発火時も共有）
})

RouteRuleSchema = z.object({
  name: z.string().optional(),
  when: RulePredicateSchema.default({}),                 // {} = catch-all（末尾に置く前提）
  primary: EmptyStringToNullSchema.default(null)         // rule ごとの target
})
```

`RouterSlot` からは FK 2 本を落とし、target model 参照は wire string（`"provider,model"`）で rules[] に格納する。

```prisma
model RouterSlot {
  id       String       @id @default(cuid())
  scenario ScenarioKey  @unique
  params   Json?        // { fallbacks[], subagentFallbacks[], threshold, agentRules[], subagentRules[] }
  updatedAt DateTime    @updatedAt
}
```

### Runtime の簡素化

```ts
function resolveTarget(...) {
  for (const rule of rulesFor(router, kind, scenario)) {
    if (matchesRule(rule, ctx)) return rule.primary === null
      ? undefined                                        // passthrough
      : { primary: rule.primary, fallbacks: catchAllFallbacks }
  }
  return undefined                                       // passthrough
}
```

「rules を walk して first-match」で終わり。catch-all primary の fall-through も、
`primary === null` の判定分岐も、ぜんぶ一段に潰れる。

### Priority chain の再解釈

前に整理した優先順位:

```
1. Scenario  ← classifyScenario で分類
2. Rule      ← rules[] を first-match
3. Primary   ← catch-all primary
4. Requested ← body.model passthrough
5. Fallback  ← 429 recovery chain
```

を、Primary を rule の 1 種として吸収して:

```
1. Scenario   ← classifyScenario
2. Rule       ← rules[] を first-match（末尾は when={} の catch-all）
3. Requested  ← どの rule もマッチしなければ passthrough
4. Fallback   ← 429 recovery chain
```

の 4 段に簡略化できる。

## 検討事項

### 1. Cascade delete の代替

現在 `Model` を削除すると `RouterSlot.modelId` は `onDelete: Restrict` で守られていて、
`configService` が transaction 内で slot を null-out してから削除する挙動になっている
(`applyRouter` の一連の validation)。

FK が消えると DB 側の制約はなくなり、rule 内に stale な `"provider,model"` 文字列が残る可能性がある。
対策として:

- **apply 時に stale reference を warning ドロップ** する既存ロジックを流用（すでに `validateRules` が
  malformed rule を drop している）。
- **model deletion のたびに全 rule をスキャン**して該当エントリを取り除く（`applyProviders` 内で）。
- **runtime の resolveTarget** が unknown model 参照を検出したら次の rule に進む（すでに `providers.get()` が
  return undefined のときの fallback で対応済み）。

FK 制約の代わりに **application-level の integrity 保証** に切り替える形。
既存の同種のフィールド（`fallbacks[]` は昔から wire string）はこの方式で 2 年以上運用できているので、
実質的な後退にはならない。

### 2. Migration

既存 DB の `RouterSlot.modelId` / `subagentModelId` を、`params.agentRules` / `params.subagentRules` の
末尾に `when: {}` の catch-all rule として fold する。

```sql
-- 1. 既存 rules[] の末尾に catch-all rule を追加
UPDATE "RouterSlot" AS s
SET params = COALESCE(params, '{}'::jsonb) || jsonb_build_object(
  'agentRules',
  COALESCE(params -> 'agentRules', '[]'::jsonb) ||
    CASE WHEN modelId IS NOT NULL THEN
      jsonb_build_array(jsonb_build_object(
        'when', '{}'::jsonb,
        'primary', (SELECT p.name || ',' || m.name FROM "Model" m JOIN "Provider" p ON p.id = m."providerId" WHERE m.id = s.modelId)
      ))
    ELSE '[]'::jsonb END,
  'subagentRules',
  COALESCE(params -> 'subagentRules', '[]'::jsonb) ||
    CASE WHEN subagentModelId IS NOT NULL THEN
      jsonb_build_array(jsonb_build_object(
        'when', '{}'::jsonb,
        'primary', (SELECT p.name || ',' || m.name FROM "Model" m JOIN "Provider" p ON p.id = m."providerId" WHERE m.id = s.subagentModelId)
      ))
    ELSE '[]'::jsonb END
);

-- 2. FK カラムを drop
ALTER TABLE "RouterSlot" DROP COLUMN "modelId";
ALTER TABLE "RouterSlot" DROP COLUMN "subagentModelId";
```

migration 単発で済む。既存の rules[] の順序は保たれ、catch-all はその末尾に追加される。
先頭に predicated rule を持っていたユーザーは何もしなくて良い。

### 3. UI

`RoutingEditorPanel` の RouteSection から「Primary + Fallback catch-all」セクションを削除、
`RuleEditor` を格上げする形。

- 既存: `[Primary picker] + [Fallback list] + [Rule list]` の 3 段
- 新: `[Rule list（末尾は catch-all）] + [Fallback list]` の 2 段

catch-all rule の表現:
- rules[] の最後の rule が `when: {}` なら、視覚的に「catch-all」バッジを付ける
- 明示的な "make this rule catch-all" ボタンで既存 rule から `when` を空にできる
- 新規追加時のデフォルトは「rules[] が空なら catch-all として追加」、
  既に rule がある場合は predicate 付きの空 rule を追加（末尾 or 現在の catch-all の直前）

### 4. 空の RouteTarget = passthrough

現状「Primary 未設定」は「passthrough（`req.body.model` そのまま）」を意味する。
新モデルでは **rules[] が空**、または「マッチする rule がない」とき passthrough。
セマンティクス的には既存と同じ。

### 5. Fallback 廃止の可能性

fallback を rule に纏めれば **rule ごとに独自の failover chain** も持てるが、
これは前に「rule の fallback は不要」で片付けた経緯がある。scenario 共有の catch-all 1 本で十分。

`fallbacks[]` フィールドは残す。

## Phase 分割

1. **Phase 1: Migration**
   - Prisma migration で `modelId` / `subagentModelId` を rules[] の末尾 rule に fold + FK カラム drop。
   - 既存 config は変換後も同じ挙動になる（rules walk → 末尾の catch-all rule で今の primary と同値）。
   - Prisma model から FK 定義を削除、`RouterSlot.model` / `subagentModel` relation も削除。

2. **Phase 2: Zod schema 変更**
   - `RouteTargetSchema` から `primary` フィールドを drop。
   - `RouteRuleSchema.fallbacks` も drop（すでに runtime は無視）。
   - `flattenNestedRouter` の出力から `agent` / `subagent` / `agentFallbacks` / `subagentFallbacks` の
     primary マップを削除、rules マップ + scenario-shared fallbacks に統一。

3. **Phase 3: Runtime**
   - `resolveTarget` を rule walker 単一に。「catch-all primary への fall-through」ロジックを削除。
   - `primaryFor` / 分離された FlatRouteMap は不要になる。

4. **Phase 4: API layer**
   - `applyRouter` の `resolvePrimaryModelId` を撤去、`validateRules` に一本化。
   - `composeUiConfig` の primary 読み取りを撤去。

5. **Phase 5: UI**
   - `RoutingEditorPanel` の RouteSection を rules-only 表示に書き換え。
   - Rule 一覧の末尾の `when: {}` を視覚的に catch-all として区別。
   - `connectModel` / drag → 空の rules[] なら即 catch-all rule を挿入、既にあれば Fallback/Rule 選択ダイアログ。
   - Routing map の edge も rule primary edge のみに（catch-all primary edge は catch-all rule edge に置換）。

6. **Phase 6: Tests**
   - `scenario-router.test.ts`, `edit-actions.test.ts`, `config-service.test.ts` の primary 直指定を
     rules[末尾 catch-all] に書き換え。
   - `flatten-nested-router.test.ts` の agent/subagent 直指定マップの assertion を修正。

## リリース目安

破壊的変更を含むが、pre-1.0 相当ではないので **v2.40** の minor bump 相当。
schema の wire shape が変わる（`primary` が消える）が、runtime は post-migration の rules[] で完全上位互換になる。

外部 API 互換性は保つ:
- `/api/config` の Router body の書き込み時、旧クライアントが `primary` を送ってきた場合は
  末尾の catch-all rule に自動変換して受け入れる（apply レイヤの後方互換）。
- 読み出しでは新形式のみ返す（旧 UI はもう存在しない前提）。

## 未決事項

- 「rule の順序」を UI でどう表現するか（今の priority 番号 + 末尾 catch-all の視覚区別で足りるか、
  drag&drop UX が要るか）。
- catch-all を削除するときの安全策（他に rule がなく、fallback もなければ「全リクエスト passthrough」
  になるので、UI で warning を出す）。
- 初期セットアップ（DB seed）で catch-all rule を prefill するか、
  空の状態から始めさせるか（後者だと初回起動時に全リクエストが passthrough → CC に空 response を返す危険）。
  推奨は前者（seed に catch-all rule を含める）。
