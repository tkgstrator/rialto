[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> 面向 LLM 流量的路由网关：在入口接收四种线路格式，并把每个请求分发到你配置的任一提供商——无需改动客户端的设置。

## ✨ 功能

- **四个入口面（inbound surface）** — Anthropic Messages（`/v1/messages`）、OpenAI Chat Completions、OpenAI Responses 以及 Gemini `generateContent`。一个入口面所需的全部知识都集中在一个描述符里，因此四个面共享同一套认证、错误信封、流式传输与请求历史。
- **链式路由** — 每个场景（`default`、`think`（计划模式）、`longContext`、`webSearch`、`image`）× 每条通道（`agent` / `subagent`）各有一条有序的 `provider,model` 链。选择器沿链遍历，跳过已耗尽或已关闭的目标，链的其余部分就是兜底列表。
- **直通（passthrough）** — 或者让调用方自己选：处于 passthrough 模式的入口面（或单个访问令牌）会把调用方自己的 `body.model` 原样送往上游。
- **带账户轮换的故障切换** — 收到 429 时先轮换到对等的订阅账户，账户耗尽后再继续遍历链的其余部分。链的顺序按你写的执行，包括订阅型 primary 落到 api_key 条目。
- **人格** — 在不修改 Claude Code 的前提下，为每个 `/v1/messages` 请求追加一段命名的系统提示。人格库的管理和当前人格的选择都在 Settings → Personas。
- **多提供商支持** — 连接 API Key 型提供商（Anthropic、OpenAI、DeepSeek、Gemini、Groq、OpenRouter 等）或订阅型提供商（Claude Code OAuth、OpenAI Codex）。
- **订阅监控** — 追踪速率限制窗口，比较实际 API 费用与订阅费用。
- **用量与成本仪表板** — 按提供商和模型细分的费用明细及每日费用图表。
- **请求历史** — 浏览过去的会话，包含每个请求的统计信息和已归档的对话记录。
- **签发式访问令牌** — 可单独吊销、可按请求归因，并可限定到某一个入口面和某一条路由配置链。
- **Web 管理界面** — 完整的浏览器端配置管理，无需手动编辑 JSON。
- **转换器管道** — 转换链由提供商的 API 风格与认证模式推导而来，因此界面上展示的就是实际运行的。
- **状态栏** — 在 Claude Code 状态栏中实时显示 Rialto 状态。
- **Docker 优先部署** — 包含 PostgreSQL 和 Redis 的一键 `docker compose up -d`。

## 🖥️ Web 界面

Web 界面（默认在端口 **3456** 提供服务）让你全面掌控网关的各项设置。界面由五个页面组成：

| 页面 | 路由 | 用途 |
|------|------|------|
| **Overview** | `/overview` | 一览流量、支出与订阅窗口的健康状况 |
| **Routing** | `/routing` | 按场景与通道展示的链条、每个入口面的路由模式与配置链，以及配置链的约束（含 `longContext` 阈值）|
| **Providers** | `/providers` | 添加、编辑或删除 API Key 型与订阅型提供商；每个提供商的模型、价格、上下文窗口、连接测试，以及只读的推导请求形状 |
| **Activity** | `/activity` | 会话、逐请求日志（`/activity/requests`）与服务器日志（`/activity/logs`）|
| **Settings** | `/settings` | Server、**Access**（签发 `/v1/*` 令牌）、Logging、Personas、Status line、Advanced |

首次启动会落到 `/setup`。

> 截图正在按当前界面重新拍摄；`docs/images/` 下的图片展示的是已废弃的旧界面，与其留下一张错误的产品图，不如先从本页移除。

## 🚀 Docker 快速启动（推荐）

安装 [Docker](https://docs.docker.com/get-docker/) 与 [Docker Compose](https://docs.docker.com/compose/install/) 后：

**步骤 1 — 创建工作目录：**

```shell
mkdir -p ~/rialto ~/.rialto
cd ~/rialto
```

配置文件会在首次启动时自动创建。只有当你需要一个应急管理密钥时，才需要自己写一份：

```shell
cat > ~/.rialto/config.json << 'EOF'
{
  "APIKEY": "your-secret-key"
}
EOF
```

> **`APIKEY` 是可选的，并且不再自动生成。** 运行 Rialto 那台机器上的浏览器不受管理网关限制，远程管理访问则应当经由 Cloudflare Access。只有当你希望在 Access 故障时仍有一条恢复通路时，才有意识地设置它——它只保护 `/api/*`。
>
> **它永远不能用于 `/v1/*` 的认证。** 客户端使用你在 **Settings → Access** 中签发的*访问令牌*连接。令牌可单独吊销、可按请求归因，并可限定到某个入口面与路由配置链。一个令牌都没签发的部署无法代理任何请求。

**步骤 2 — 下载 `compose.yaml`：**

```shell
curl -fsSL https://raw.githubusercontent.com/tkgstrator/rialto/master/compose.yaml -o compose.yaml
```

**步骤 3 — （可选）把提供商凭据写入 `.env`：**

```shell
cat > .env << 'EOF'
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
EOF
```

**步骤 4 — 启动服务：**

```shell
docker compose up -d
```

服务器会在 `http://127.0.0.1:3456` 启动。用浏览器打开该地址，在 **Providers** 与 **Routing** 页面完成配置，然后在 **Settings → Access** 签发一个访问令牌——客户端要用的就是它。

**步骤 5 — 把 Claude Code 指向网关：**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

或写入 shell 配置文件长期生效：

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**步骤 6 — 为你使用的入口面开启路由：**

所有入口面出厂时都是 `passthrough` 模式，直接沿用调用方自己的 `body.model`。当你有了可路由的目标之后，在 **Routing** 页面把 `/v1/messages`（或你实际调用的那个面）切换为 `routed`。参见下文的[入口面](#-入口面inbound-surface)。

**查看日志：**

```shell
docker compose logs -f
```

**手工改过 `config.json` 后重启：**

```shell
docker compose restart
```

通过界面修改的 envelope 值会立即生效——保存时会一并写入进程环境变量。Rialto 没有 CLI。

## 🔌 连接提供商

### API Key 型提供商

在 **Providers** 页面选择任意 API Key 型提供商（Anthropic、OpenAI、DeepSeek、Gemini 等），填入 API Key 并保存。支持 `$VAR` 形式的环境变量插值，因此可以不把密钥直接写进配置文件。

### 订阅型提供商（Claude Code 与 Codex）

Rialto 可以在没有逐次调用 API Key 的情况下经由订阅型提供商路由。

**Claude Code** — 打开 **Providers** 页面 → **Subscription** 标签页 → **Connect**，完成 OAuth 流程。Rialto 会保存并自动刷新凭据。

**Codex（OpenAI）** — 目前不支持浏览器登录，认证仅支持上传凭据文件。

> **服务条款提示：** 使用 Claude Code 订阅来服务 Claude Code 以外的应用程序，可能违反 [Anthropic 的使用政策](https://www.anthropic.com/legal/aup)。是否使用该功能请自行判断并承担风险。

## 🚪 入口面（inbound surface）

Rialto 不只是 Claude Code 的代理。入口处接收四种线路格式，每一种都由 `src/llms/inbound/surfaces.ts` 中的单个描述符定义：

| 入口面 | 路径 | 典型客户端 | 凭据 | 错误信封 |
|---|---|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | Claude Code | `x-api-key` 或 `Authorization: Bearer` | `{type:'error', error:{type,message}}` |
| `openai-chat` | `POST /v1/chat/completions` | OpenAI SDK、Cline、OpenWebUI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `openai-responses` | `POST /v1/responses` | Codex CLI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `gemini-generate` | `POST /v1beta/models/<model>:<action>` | Gemini CLI | `x-goog-api-key` 或 `?key=` | `{error:{code,message,status}}` |

`GET /v1/models` 是目录读取而非补全面，因此不属于这四个面——但它的调用方是 OpenAI SDK，所以仍按那一套凭据约定和错误信封作答。

无论请求落在哪个入口面，凭据都必须是**签发的访问令牌**。envelope 中的 `APIKEY` 仅在 `/api/*` 上被接受。

### 路由模式

每个入口面都有一个已存储的模式：

| 模式 | 行为 |
|---|---|
| `passthrough` | 模型由调用方指定。场景分类、链与主动故障切换全部跳过。 |
| `routed` | 走链：场景分类 → 沿链遍历 → 故障切换。 |

**所有入口面初始都是 `passthrough`。** 对一个尚未配置的部署做路由毫无意义——没有链时，选择器只会径直落回调用方自己的模型——因此路由是在有了可路由目标之后，按入口面逐个开启的。每个入口面还可以绑定自己的路由配置链，比如把 CI 客户端所用的那个面固定在 cost-first 链上。两种模式各自如何处理 `body.model`，见[链与直通](#链与直通)。

## ⚙️ 配置

### 磁盘配置（`~/.rialto/config.json`）

存储启动时的标量值和磁盘常驻对象。支持环境变量插值（`$VAR` / `${VAR}`）和 JSON5 注释。自动保留最近三个备份。schema 未声明的键会被保留而不是丢弃。

| 键 | 说明 |
|----|------|
| `APIKEY` | `/api/*` 的可选应急密钥，通过 `x-api-key` 或 `Authorization: Bearer` 发送。`/v1/*` 永不接受。不会自动生成 |
| `HOST` | 监听地址（默认：`127.0.0.1`）|
| `PORT` | 监听端口（默认：`3456`）|
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access 团队域名。与 `ACCESS_AUD` 一起校验 `/api/*` 的 assertion |
| `ACCESS_AUD` | Access 应用的 AUD 标签。**两者都设置才会生效** |
| `LOG` | `true` 以启用日志文件 |
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `PROXY_URL` | 上游 API 请求的 HTTP 代理 |
| `API_TIMEOUT_MS` | 上游 API 调用超时时间（ms）。同时会被夹到 Bun 的逐请求空闲超时 1–255 秒区间内 |
| `CLAUDE_PATH` | `claude` 可执行文件路径 |
| `NON_INTERACTIVE_MODE` | Docker / CI 环境下设为 `true`（防止 stdin 挂起）|
| `CAPTURE_REQUESTS` | 为每个请求记录一行 `RequestLog`（默认 `true`）|
| `CAPTURE_MESSAGES` | 归档对话记录（默认 `true`）|
| `REDACT_TOOL_ARGUMENTS` | 从归档中剔除工具调用参数（默认 `false`——开启后丢失的信息无法恢复）|
| `ROUTING_SCHEDULER_INTERVAL_MS` | 调度器 tick 间隔，60 000–3 600 000（默认 `300000`）|
| `Personas` | 人格库（数组）|
| `ActivePersona` | 当前人格的 uuid id；`null` / 缺失 / 空字符串表示无。在 `/api/config` 的线路上同样是顶层键 |
| `StatusLine` | 状态栏配置对象 |

旧版本为已不存在的路由机制写下的键——`Router`、`CUSTOM_ROUTER_PATH`、`LiveRoutingName`、`CROSS_PROVIDER_FALLBACK`、`ROUTER_MODE`——一律忽略。`POST /api/config` 会带着警告丢弃它们，下一次保存时把它们从文件中清掉。

### 提供商、模型与链（数据库）

提供商、模型、偏好链以及每个入口面的路由模式存放在 PostgreSQL 中，通过 Web 界面（`POST /api/config`、`PUT /api/router-preferences`、`POST /api/inbound-surfaces`）管理。`config.json` **内部**的 `Providers` 键是每次保存后从数据库回写的单向镜像——手工修改不会产生任何效果，并会在下一次写入时被覆盖。路由相关的内容不再镜像到磁盘。

### 链与直通

这是 Rialto 对 `body.model` 会做的仅有的两件事。

**链**（`routed`）。请求先被分类到一个场景和一条通道，选择器再沿该通道的有序 `provider,model` 链遍历。链来自请求解析到的配置链——访问令牌指定了就用它的，否则用入口面的，再否则用 `live`。第一个已启用、未耗尽且装得下本次请求的条目成为 `body.model`，链的其余部分作为兜底列表随行。遍历一无所获时的行为由配置链上的两点决定：

- `exhaustedBehavior` — 通道有条目，但每一条都被门槛拦下。`429`（默认）不触碰任何上游，直接向客户端返回 `rate_limit_error` 和 `Retry-After` 头；`passthrough` 则改为发送调用方自己的 `body.model`，且没有兜底。
- **一个条目都没有**的通道永远不会返回 429，无论 `exhaustedBehavior` 是什么：未配置的通道是「没有意见」，调用方自己的模型按原样送出。链无法加载、或路由因其他原因失败时也一样——Rialto 从不凭空编造目标，它只会把 `body.model` 替换成链上的某个条目。

**直通**（`passthrough`，或被固定到保留配置链 `passthrough` 的访问令牌）。调用方的 `body.model` 按原样送往上游：`provider,model`，或恰好只有一个已启用提供商托管的裸模型名。在这种模式下，入口面可以拒绝特定的 `provider,model` 组合。

无论哪种模式，在 Providers 页面关闭的提供商或模型都不会被派发——不会来自链条目，不会来自直通请求，不会作为兜底目标，也不会经由已关闭的订阅型提供商的账户。手工点名也会被拒绝而不是转发。

### 路由场景

在 **Routing** 页面为每个场景配置使用的模型：

| 场景 | 触发时机 |
|------|---------|
| `default` | 未匹配其他场景的所有请求 |
| `think` | 请求显式开启了扩展思考（`thinking.type` 为 `enabled` 或 `adaptive`；显式的 `disabled` **不算**）|
| `longContext` | token 数超过阈值，或 effort / 层级信号判定为「重」|
| `webSearch` | 请求携带 `web_search*` 工具 |
| `image` | 图像相关任务 |

**不存在 `background` 场景。** 迁移 `20260728_router_rules_drop_background` 已把它折叠进 `default`。

每个场景有两条通道——普通流量走 `agent`，携带子代理标签的请求走 `subagent`——每条通道各自拥有独立的有序链。只有当通道上至少有一个可用条目时，该场景才会被选中；否则请求落到 `default`。

**`longContext` 的阈值不是一个固定数字。** 若在配置链的约束（Routing 页面）里设置了阈值，以它为准。未配置时取链上 `default` / `agent` 通道第一个条目所声明的上下文窗口的 70 %（为回复留出余量）。两者都无法解析时，才回退到 128 000 token。

### effort、层级与兜底

除了上面的场景触发器，路由器还会对每个请求做分级，并按顺序遍历兜底链：

- **分级信号** — `output_config.effort`（`high`/`xhigh`/`max` → 重 → `longContext`；`low`/`medium` → 显式的轻），以及从 `body.model` 解析出的请求模型层级（opus → 重）。层级只在 effort 缺失时才读取，因此旧版 Claude Code 流量仍能正确分级；显式的 low/medium effort 会抑制层级升级，让调用方主动把 opus 请求降级。
- **每场景兜底链** — 路由器遍历 `[primary, ...fallbacks]`，挑选第一个既未被标记耗尽、其声明的 `contextWindow` 又装得下本次请求的候选。
- **能力门** — 切换永远不会落到一个 `contextWindow` 容不下本次请求的模型上。未声明窗口的模型默认放行（unknown = allow，保守默认值）。
- **429 时的账户轮换** — 订阅型提供商返回 429 时，会把该子账户标记为耗尽（直到真实的 `resetAt`，上游未给出时则为 5 分钟），并在对等账户上重试同一条链条目，最多轮换 10 次。只有当对等账户全部用尽时，才会标记整个提供商并前进到下一个链条目。
- **链的顺序按你写的执行** — 不存在 `auth_mode` 门。订阅型 primary 会保留写在它后面的 api_key 兜底，同一提供商的兜底也会被遍历（耗尽是按 `(provider, model)` 标记的）。如果不想让订阅额度溢出到按量计费，就不要把 api_key 条目写在它后面。
- **多账户均衡** — 当同一提供商上启用了多个 SubAccount 时，会话路由器先剔除已记录的硬限制窗口已达 100 % 的账户，若粘性的会话→账户映射仍指向幸存者则复用它，否则挑选 `剩余百分比 ÷ 距离重置的剩余时间` 最大的那个账户——也就是最有可能把配额浪费掉的那一个。

决策会以结构化日志记录：主动放弃 primary 时输出 `{ from, to, scenario, tokenCount, trace }`，所有候选都被拒绝时输出 dead-chain 警告，让你能看清尝试了什么、为何被拒。`trace` 中每一项都带有 `kept` / `exhausted` / `capability` / `malformed` 之一。

> **不存在周维度排空守卫。** 早期版本会在订阅型提供商的周窗口越过线性排空目标时提前切换，并用 `Router.weeklyDrainMarginPct` 调节余量。二者均已删除。订阅型提供商现在会一直跑到上游上限，并根据真实发生的 429 做被动轮换——因为只有这个信号永远不会错。

### 人格

*人格*是一段命名的系统提示片段，在场景判定之后，会被追加到每一个面向用户的请求里。借助它可以在不修改 Claude Code 本体的前提下，让 Claude Code 始终保持某种口吻、角色或工作守则。

- **人格库** — `Personas` 是磁盘 envelope 上的顶层数组。每个条目都带有一个稳定的 uuid `id`、显示用的 `name`（无需唯一）和正文 `prompt`。新装环境会附带一个小型的初始人格库；既有环境则保留磁盘上已经存在的内容。
- **当前激活** — 每个部署只能有一个激活的人格。它的 uuid id 就是顶层的 `ActivePersona` 键，在磁盘 envelope 和 `/api/config` 的线路上位置相同。`null` / 缺失 / 空字符串表示「无人格」。不存在项目级或会话级的覆盖文件。
- **注入方式** — 路由器解析完场景后，会把当前人格的 `prompt` 追加到带有 `cache_control` 的最后一个 system 块上（若没有则退回到最后一个字符串文本块）。这样人格就被收纳进缓存前缀的*内部*，既不会消耗额外的 cache 断点，又能在多次请求之间保持字节级稳定（保留 Anthropic 的 prompt cache）。当 `system` 为字符串 / 未定义时进行拼接；多块数组形式则原地修改。
- **入口面限制** — 人格注入**只在 `/v1/messages` 上运行**，而且只对 routed 流量生效：passthrough 入口面，或固定到 `passthrough` 配置链的令牌，会整个跳过路由器，人格也随之跳过。OpenAI 兼容面与 Gemini 面根本不接受被撑大的 `system` 字段（Codex 会返回 `Unsupported parameter: system`），因此宁可跳过注入也不让请求失败。在 `/v1/messages` 上，**所有场景**都会继承当前人格——不存在按场景的例外。
- **与子代理交互** — 人格注入在子代理标签处理*之后*执行，所以子代理的逐次系统内容不会被覆盖，而是与人格合成。

人格库的管理和当前激活人格的切换都在 **Settings → Personas**（`/settings/personas`）。「无人格」是默认的 no-op。

关于如何撰写高还原度的人格（结构模板、反模式列举、`think` 请求下的思考过程控制），请参见 [docs/guides/persona-authoring.md](docs/guides/persona-authoring.md)。

### 转换器

转换器把请求转换为各提供商的线路格式。Rialto 内置六个，且该集合在构建时固定——没有插件加载器。

| 转换器 | 绑定对象 | 职责 |
|-------------|----------|-----|
| `anthropic` | `/v1/messages` | Anthropic 原生线路格式 |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions |
| `openai-responses` | `/v1/responses` | OpenAI Responses API——Codex 系模型 |
| `gemini` | `/v1beta/models/:modelAndAction` | Google Gemini |
| `claude-code-oauth` | 订阅认证 | 注入 Claude Code 的 OAuth bearer（自动刷新） |
| `codex-oauth` | 订阅认证 | 注入 ChatGPT / Codex 的 OAuth bearer |

**链是推导出来的，不是配置出来的。** 上述转换器要么绑定端点，要么绑定认证，没有可选空间：Rialto 根据提供商的 API 风格与认证模式确定链。

| API 风格 | api_key | subscription |
|---|---|---|
| `anthropic` | *（无需转换步骤）* | `claude-code-oauth` |
| `openai_chat` | `openai` | *不支持* |
| `openai_responses` | `openai-responses` | `openai-responses` → `codex-oauth` |
| `gemini` | `gemini` | *不支持* |

Anthropic 提供商没有转换步骤，是因为请求本就是该线路格式。不支持的组合会导致该提供商根本不被注册，而不是在缺少凭据的情况下被调用。

若某个模型自身的 API 风格与其提供商不一致（例如托管在常规 OpenAI 提供商下的 Codex 系模型），则仅对该模型的请求追加相应的转换步骤。

`provider.transformer.use` 已不再被读取：旧配置中残留的 `use` 块会在加载时丢弃。推导出的链以只读形式显示在 Providers 页面的 **Request shape** 中，请求异常时应首先查看这里。

### 子代理路由

提示词中的子代理标签会把该子代理导向场景的 **`subagent` 通道**：

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
请帮我分析这段代码...
```

**只有标签的存在与否有意义，其内容会被忽略。** 标签只负责选择通道；模型来自 **Routing** 页面上该通道的配置。这是刻意的设计——让子代理路由集中在一处编辑，而不是散落在每个子代理的提示词文件里。标签会在请求发往上游之前被剥离，因此这个内部标记不会到达厂商。

`<CCR-SUBAGENT-MODEL>` 是改名前的写法，因为它存在于人们已经写好的提示词里，所以仍被接受。标签正文里仍写着旧的 `provider,model` 组合也照常工作——只是那个组合不会被读取而已。

## 🔀 OpenAI 兼容与 Gemini 兼容入口面

任何 OpenAI SDK 调用方（Codex CLI、Cline、OpenWebUI、Python / JS 的 `openai`、`curl`）以及任何 Gemini SDK 调用方，都可以像使用普通厂商端点那样消费你的**订阅额度**（Claude Max、ChatGPT Plus/Pro）。调用方看到的是普通的请求 / 响应；在 Rialto 背后，请求会被送往你已完成 OAuth 认证的账户，因此费用留在月度订阅内，而不是走按量计费的 API 账单。

### 端点（OpenAI 线路形状）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/v1/models`             | 以 `{object:'list', data:[…]}` 返回数据库中已启用的模型列表。每个 `id` 都是 Rialto 的规范 `provider,model` 形式，可直接用于下一次调用。 |
| `POST` | `/v1/chat/completions`   | 标准 Chat Completions——支持流式与非流式。body 的 `model` 字段接受 `/v1/models` 返回的 `provider,model` id。 |
| `POST` | `/v1/responses`          | OpenAI Responses API——支持流式与非流式。模型寻址方式同上。 |

这三个路径的认证**仅接受 `Authorization: Bearer <签发的访问令牌>`**（`x-api-key` 属于 Anthropic 的约定，在这里会被拒绝；401 的响应体遵循 OpenAI 的 `{error:{message,type,code}}` 形状）。Anthropic 面（`/v1/messages`）额外读取 `x-api-key`，但其取值同样必须是签发的访问令牌。

### 示例 — 用 OpenAI Python SDK 调用你的 Codex 订阅

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="rialto_your-access-token",   # Settings → Access，不是 APIKEY
)

# 1. 列出可路由的模型
for m in client.models.list().data:
    print(m.id, m.owned_by)
# → codex,gpt-5.6-luna  (owned_by=codex)
# → claude-code,claude-sonnet-5  (owned_by=claude-code)
# ...

# 2. Chat Completions（经由你的 Codex Plus/Pro 订阅路由）
res = client.chat.completions.create(
    model="codex,gpt-5.6-luna",
    messages=[{"role": "user", "content": "reply pong"}],
)
print(res.choices[0].message.content)  # → pong
```

### 示例 — OpenAI JS SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: process.env.RIALTO_ACCESS_TOKEN, // Settings → Access
})

const stream = await client.chat.completions.create({
  model: 'codex,gpt-5.6-luna',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

任何支持覆盖 `base_url` / `baseURL` 的客户端都同理。

**这些入口面上哪些能力生效。** 故障切换、账户轮换以及 `provider,model` 寻址始终生效。链式路由只有在把该入口面从 `passthrough` 切换为 `routed` 之后才生效。人格注入**不**生效——它只作用于 `/v1/messages`（见上文「人格」）。

## 📊 日志

- **服务器级日志**（pino）：`~/.rialto/logs/rialto-*.log` — HTTP 请求、API 调用、服务器事件。级别由 `LOG_LEVEL` 控制。
- **应用级日志**：`~/.rialto/rialto.log` — 路由决策和业务逻辑事件。

两者都可以在界面的 **Activity → Logs** 中查看。

## 🌐 对外公开部署

通过隧道公开 Rialto 时，`/api/*` 与 `/v1/*` 必须区别对待——前者置于 Cloudflare Access 之后，后者在边缘放行、仅由签发的令牌把守。完整的配置步骤，以及会让 CLI 客户端卡在登录页的那些失败模式，见 [docs/guides/public-deployment.md](docs/guides/public-deployment.md)。

## ⬆️ 从改名前的版本升级

主目录、环境变量、数据库名、Docker 镜像以及 thinking signature 前缀都随着改名为 Rialto 而变化。请参见 [docs/guides/migration-v3.md](docs/guides/migration-v3.md)。

## 🛠️ 开发

### 前置条件

- Bun ≥ 1.1.0
- PostgreSQL
- Redis

开发容器（`.devcontainer/compose.yaml`）会自动提供 `postgres` 与 `redis`，并在全新数据卷上创建独立的测试数据库 `rialto_test`。

### 初始化

```shell
bun install
```

```shell
# .env
DATABASE_URL=postgres://postgres:password@postgres:5432/rialto
TEST_DATABASE_URL=postgres://postgres:password@postgres:5432/rialto_test
REDIS_URL=redis://redis:6379
```

```shell
bun run db:migrate
bun run dev         # Vite（端口 16175）：提供 SPA，并经由 @hono/vite-dev-server
                    # 提供 /api/*、/v1/*、/health 与 /callback 的 Hono 应用
```

### 构建

```shell
bun run build       # Vite 生产构建（单文件输出到 dist/）
```

### 测试

```shell
bun test                  # 完整测试套件
bun run test              # 仅 __tests__/lib __tests__/db __tests__/preset
bun run test:providers    # 提供商契约测试（回放固定装置）
```

`bun test` 与 `bun run test` 是**两个不同的命令**。CI 会跑 Build / Type Check / Test 三道关卡。

### 检查

```shell
bunx tsc --noEmit
bunx biome check --write .
bunx knip                 # 死代码盘点
```

### 数据库工具

| 脚本 | 用途 |
|------|------|
| `bun run db:generate` | 重新生成 Prisma 客户端（也会在 `postinstall` 时运行）|
| `bun run db:migrate` | 创建并应用迁移（开发）|
| `bun run db:migrate:deploy` | 应用已有迁移（生产 / CI）|
| `bun run db:migrate:test` | 把迁移应用到独立的 `rialto_test` 数据库 |
| `bun run db:reset` | 删除并重建 schema（破坏性）|
| `bun run db:seed` | 幂等的种子数据——`live` 偏好配置链 |
| `bun run db:studio` | 打开 Prisma Studio |

请务必通过 Prisma 迁移进行变更，不要直接编辑 DDL。**任何迁移之后都要同时跑 `db:migrate:test`**，否则 CI 会在测试数据库上失败。

### 价格数据抓取

| 脚本 | 用途 |
|------|------|
| `bun run scrape:openai-prices` | 抓取 OpenAI 模型价格 |
| `bun run scrape:anthropic-prices` | 抓取 Anthropic 模型价格 |
| `bun run scrape:google-prices` | 抓取 Google / Gemini 价格 |
| `bun run scrape:prices` | 抓取以上全部 |
| `bun run seed:prices-db` | 把抓取到的价格写入数据库 |

### 发布

| 脚本 | 用途 |
|------|------|
| `bun run release` | 构建并发布 Docker 镜像 |
| `bun run release:docker` | 仅发布 Docker 镜像 |

### 架构文档

- [`docs/architecture/inbound-surfaces.md`](docs/architecture/inbound-surfaces.md) — 入口面注册表，以及由它推导出的一切
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — 启动 → 请求 → 上游 → 响应整形的完整链路
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — 路由决策与 429 轮换的放大图
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — 测试在哪里、覆盖了什么

## 许可证

MIT — 参见 `LICENSE`。
