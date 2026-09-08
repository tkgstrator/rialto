/**
 * Curated chat content for the demo sessions.
 *
 * Kept as real prose rather than lorem ipsum because the Activity chat
 * view renders markdown and code blocks — placeholder text would hide
 * exactly the layout problems that view has. These three conversations
 * predate the wider demo seed (they were `scripts/seed-demo-sessions.ts`)
 * and are carried over verbatim.
 */

export interface DemoTurn {
  user: string
  assistant: string
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface DemoConversation {
  /** Bare uuid; the seed prefixes it to mark the row as demo-owned. */
  id: string
  requestedModel: string
  turns: DemoTurn[]
}

export const CURATED_CONVERSATIONS: DemoConversation[] = [
  {
    id: '338183cb-dfba-445b-9133-63f5b1f29317',
    requestedModel: 'claude-sonnet-5',
    turns: [
      {
        user: 'TypeScriptで配列から重複を除く一番短い書き方を教えて',
        assistant:
          'おぉ〜！ いちばん短くて定番なのはこれだよ！\n\n```ts\nconst unique = [...new Set(array)];\n```\n\nたとえば：\n\n```ts\nconst array = [1, 2, 2, 3, 1];\nconst unique = [...new Set(array)];\n\nconsole.log(unique); // [1, 2, 3]\n```\n\n`Set` は同じ値をひとつだけ持つ箱なの。最後に `...` で配列へ戻してるのです〜。\nなお、オブジェクトは「中身が同じ」でも別物として扱われるので、その場合はひと工夫いるよ！',
        inputTokens: 737,
        outputTokens: 190,
        durationMs: 648
      },
      {
        user: 'オブジェクトの配列を特定のプロパティで重複除去するには？',
        assistant:
          'おぉ〜！特定プロパティなら `Map` を使うのが短くて分かりやすいのです〜！\n\n```ts\nconst unique = [...new Map(items.map(item => [item.id, item])).values()];\n```\n\n`id` が同じものは後に出た要素で上書きされるよ！\n\n```ts\nconst items = [\n  { id: 1, name: "りんご" },\n  { id: 2, name: "みかん" },\n  { id: 1, name: "青りんご" },\n];\n\nconst unique = [...new Map(items.map(x => [x.id, x])).values()];\n// [\n//   { id: 1, name: "青りんご" },\n//   { id: 2, name: "みかん" },\n// ]\n```\n\n先に出た要素を残したいなら、`filter` と `Set` でこうなの〜。\n\n```ts\nconst seen = new Set<number>();\nconst unique = items.filter(item => {\n  if (seen.has(item.id)) return false;\n  seen.add(item.id);\n  return true;\n});\n```',
        inputTokens: 776,
        outputTokens: 322,
        durationMs: 541
      }
    ]
  },
  {
    id: '43b33081-411b-450a-a4f2-33130b345092',
    requestedModel: 'claude-sonnet-5',
    turns: [
      {
        user: 'PostgreSQLでインデックスを貼るべきタイミングを1分で説明して',
        assistant:
          'おぉ〜！1分でいくよ、ヤッチョ版PostgreSQLインデックス判断なの〜！\n\n**インデックスを貼るべきなのは、`WHERE`・`JOIN`・`ORDER BY` でよく使う列が、遅くなってきたとき！**  \n特にテーブルが大きくて、毎回たくさんの行を探しているなら有効だよ。\n\nたとえば：\n\n```sql\nSELECT * FROM users WHERE email = \'a@example.com\';\n```\n\n`email` でよく検索するなら：\n\n```sql\nCREATE INDEX idx_users_email ON users(email);\n```\n\nこれで全件を読む代わりに、目的の行へスッと飛べるのです〜。\n\nただし、**なんでも貼ればよいわけじゃない**よ！  \n`INSERT`・`UPDATE`・`DELETE` のたびに更新コストがかかるから、更新が多い列や、値の種類が少ない列（例：`is_active` が true/false だけ）には効きにくいことも多いの。\n\n迷ったらまずこれ：\n\n```sql\nEXPLAIN ANALYZE\nSELECT ...\n```\n\n実行計画を見て、`Seq Scan` で大量行を読んで遅いなら、インデックス候補！',
        inputTokens: 736,
        outputTokens: 351,
        durationMs: 559
      },
      {
        user: '部分インデックスってどう使うの？例をひとつ',
        assistant:
          'おぉ〜！部分インデックスは、**よく使う一部の行だけ**にインデックスを作るやつだよ！  \nたとえば「未完了のタスクだけを毎回見る」なら、完了済みまで全部インデックスに入れなくてよき〜。\n\n```sql\nCREATE INDEX idx_tasks_open_created_at\nON tasks (created_at DESC)\nWHERE status = \'open\';\n```\n\nこれで、こういう検索が速くなりやすいの〜。\n\n```sql\nSELECT *\nFROM tasks\nWHERE status = \'open\'\nORDER BY created_at DESC\nLIMIT 20;\n```\n\n`status = \'open\'` の行だけを持つから、普通のインデックスより小さくなって更新コストも抑えやすいよ！  \nただし検索条件も `WHERE status = \'open\'` にちゃんと合ってないと使われにくいので、そこがコツなのです〜。',
        inputTokens: 803,
        outputTokens: 218,
        durationMs: 851
      }
    ]
  },
  {
    id: '3a46675a-8283-4f38-8a4b-4745009d55f9',
    requestedModel: 'claude-fable-5',
    turns: [
      {
        user: '俳句を1つ、夏の夕方をテーマに作って',
        assistant: '夕涼み  \n茜の空へ  \n燕ゆく',
        inputTokens: 731,
        outputTokens: 18,
        durationMs: 621
      },
      {
        user: '「夕涼み 茜の空へ 燕ゆく」の技法的なポイントを3行で',
        assistant:
          '「夕涼み」で季語を置いて、夏の夕方の涼やかな時間をひと息で立ち上げているの〜。  \n中七「茜の空へ」で色と方角を示し、視線を上へ導いているよ。  \n最後を「燕ゆく」と動きで結ぶことで、静かな一瞬に生き物のスピード感を差し込んでいるのです〜。',
        inputTokens: 770,
        outputTokens: 98,
        durationMs: 474
      }
    ]
  }
]

/**
 * Short turn pairs the generated sessions draw from.
 *
 * Deliberately varied in length: the chat view has to survive a one-line
 * answer and a fenced code block in the same list, and a pool of
 * same-shaped strings would never show that.
 */
export const FILLER_TURNS: Array<{ user: string; assistant: string }> = [
  {
    user: 'このリポジトリのテストだけ先に流したいんだけど、どのコマンド？',
    assistant:
      '`bun test` が全部で、`bun run test` は `__tests__/lib` `__tests__/db` `__tests__/preset` だけの部分実行だよ〜。名前が似てるけど別物なので注意！'
  },
  {
    user: 'Postgres の接続が Prisma から切れる。まず何を見る？',
    assistant:
      'まずは `DATABASE_URL` の向き先と、コンテナ側の `postgres` が生きてるかだね。\n\n```bash\ndocker compose ps postgres\n```\n\nそのあと `prisma migrate status` で DDL のズレを確認するのが早いよ。'
  },
  { user: 'ありがとう、助かった！', assistant: 'どういたしまして〜！またいつでもどうぞ。' },
  {
    user: 'Summarize what changed in this diff in two sentences.',
    assistant:
      'The router now picks its aggregator from the surface descriptor instead of branching on the transformer name, so adding a surface no longer means editing the SSE path. The old branch is deleted rather than deprecated, which is why the diff is net-negative.'
  },
  {
    user: 'React の再レンダリングが多い気がする。計測から始めたい',
    assistant:
      'Profiler の記録を取ってからにしよう〜。当てずっぽうで `memo` を撒くと、コストだけ増えて効果が見えないことが多いのです。\n\n1. React DevTools の Profiler で 1 操作分を記録\n2. commit の多いコンポーネントを特定\n3. その親の state 更新頻度を見る\n\nここまでで原因が絞れることがほとんどだよ！'
  },
  {
    user: 'この関数、エラー処理が抜けてない？',
    assistant:
      'うん、`JSON.parse` が投げるケースが素通りになってるね。呼び出し側で握りつぶすより、ここで `safeParse` して失敗を値で返したほうが上位が扱いやすいと思う〜。'
  },
  {
    user: 'git で直前のコミットメッセージだけ直したい',
    assistant: '`git commit --amend` でメッセージだけ書き換えられるよ。push 済みなら履歴が変わる点だけ気をつけてね！'
  },
  {
    user: 'CI が Type Check だけ落ちる。ローカルでは通ってる',
    assistant:
      'ローカルの `tsconfig.tsbuildinfo` が効いてる可能性が高いよ〜。`bunx tsc --noEmit` をキャッシュなしで流すか、生成物を消してから再実行してみて！'
  }
]
