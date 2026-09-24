[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> 面向 LLM 流量的路由网关：在入口接收四种线路格式，并把每个请求分发到你配置的任一提供商——无需改动客户端的设置。

## ✨ 功能

- **四个入口面（inbound surface）** — Anthropic Messages（`/v1/messages`）、OpenAI Chat Completions、OpenAI Responses 以及 Gemini `generateContent`。一个入口面所需的全部知识都集中在一个描述符里，因此四个面共享同一套认证、错误信封、流式传输与请求历史。
- **按场景路由** — 每个请求被归入一个场景（Default；要求思考时为 Think；输入超过自动调整的阈值时为 Long context）和一个通道（主代理或子代理），路由配置为每个场景和通道各持有一组有序的路线，每条路线点名一个提供商及其上的一个层级。它对应哪个模型由提供商的*层级别名*决定，因此新模型发布时只需挪动一个别名，而不必改动每条路线。第一条能接下请求的路线负责处理——预计会剩下配额的路线被提到前面，预计会用尽的路线被放到后面——其余构成兜底列表。
- **直通（passthrough）** — 或者让调用方自己选：处于 passthrough 模式的入口面（或单个访问令牌）会把调用方自己的 `body.model` 原样送往上游。
- **带账户轮换的故障切换** — 收到 429 时先轮换到对等的订阅账户，账户耗尽后再继续遍历该列表其余的路线。列表的顺序按你写的执行，包括订阅型路线落到 api_key 路线。
- **人格** — 在不修改 Claude Code 的前提下，为每个走路由的 `/v1/messages` 请求追加一段命名的系统提示。人格库的管理和当前人格的选择都在 Settings → Personas。
- **多提供商支持** — 连接 API Key 型提供商（Anthropic、OpenAI、DeepSeek、Gemini、Groq、OpenRouter 等）或订阅型提供商（Claude Code OAuth、OpenAI Codex），一个订阅型提供商可挂多个账户。
- **订阅监控** — 每个账户的速率限制窗口，可在 Subscriptions 列表随时刷新，路由器读取的耗尽状态也来自这里。刷新会立即作用于路由；Codex 账户积攒的速率限制重置可在其提供商页面上使用。
- **用量与成本** — Overview 显示今天、本周、本月的支出；Activity → Usage 显示按日或按周的各提供商费用，以及各账户的订阅用量。Overview 与各订阅型提供商页面还会按账户显示其流量若按 API 价格计算的金额（本周与最近 30 天）。
- **请求历史** — 浏览过去的会话，包含每个请求的统计信息和已归档的对话记录。
- **签发式访问令牌** — 可单独吊销和轮换、可按请求归因，并可限定到若干入口面和一个路由配置。
- **Web 管理界面** — 完整的浏览器端配置管理，提供英文、日文和中文；无需手动编辑 JSON。
- **转换器管道** — 转换链由提供商的 API 风格与认证模式推导而来，因此界面上展示的就是实际运行的。
- **Docker 优先部署** — 包含 PostgreSQL 和 Redis 的一键 `docker compose up -d`。

## 🖥️ Web 界面

Web 界面（默认在端口 **3456** 提供服务）让你全面掌控网关的各项设置。界面由六个页面组成：

| 页面 | 路由 | 用途 |
|------|------|------|
| **Overview** | `/overview` | 一览支出、订阅配额窗口，以及每个入口面的请求数 / 错误数 |
| **Routing** | `/routing` | 每个入口面的路由模式与路由配置；按场景（Default / Think / Long context）和通道（Agent / Subagent）依次尝试的提供商 · 层级路线，以及当前生效的 Long context 阈值；还有直通入口面允许点名的目标 |
| **Providers** | `/providers` | 两个列表——`/providers/subscriptions` 与 `/providers/api-keys`——外加用于添加的 `/providers/connect`，以及查看层级别名、模型、价格、上下文窗口、连接测试和只读推导请求形状的 `/providers/<name>` |
| **Access tokens** | `/access-tokens` | 签发、限定范围、轮换和吊销客户端在 `/v1/*` 上使用的令牌 |
| **Activity** | `/activity` | 会话、逐请求日志（`/activity/requests`）、订阅用量（`/activity/usage`）与服务器日志（`/activity/logs`）|
| **Settings** | `/settings` | Server、Access（管理访问：Cloudflare Access，以及它出故障时如何重新进入）、Logging、Personas、Status line、Advanced（配置文档、健康状态）|

首次启动会落到 `/setup`。

> 目前还没有当前界面的截图。原先 `docs/images/` 下的图片展示的是已废弃的旧界面，与其留下一张错误的产品图，不如直接删除。

## 🚀 Docker 快速启动（推荐）

安装 [Docker](https://docs.docker.com/get-docker/) 与 [Docker Compose](https://docs.docker.com/compose/install/) 后：

**步骤 1 — 创建工作目录并下载 `compose.yaml`：**

```shell
mkdir -p ~/rialto
cd ~/rialto
curl -fsSL https://raw.githubusercontent.com/tkgstrator/rialto/master/compose.yaml -o compose.yaml
```

该 compose 文件会连同 PostgreSQL 与 Redis 一起运行 `ghcr.io/tkgstrator/rialto:latest`，发布端口 `3456`，并把 `./rialto-config` 绑定挂载为容器的 `~/.rialto`——宿主机上的 `config.json` 就放在这个目录。它还会挂载 `~/.claude` 与 `~/.codex` 以供 CLI 凭据文件使用；如果只用 API Key 型提供商，删掉这两行即可。

配置文件会在首次启动时自动创建，启动前无需编写任何内容。envelope 中的每个标量值也可以作为 `rialto` 服务的环境变量提供（`PORT`、`LOG_LEVEL` 等）；已设置的环境变量优先于文件。

> **没有管理密钥。** 运行 Rialto 那台机器上的浏览器不受管理网关限制，远程管理访问经由 Cloudflare Access。Access 出故障时，SSH 登录宿主机并转发端口即可——见[对外公开部署](#-对外公开部署)。
>
> **`/v1/*` 只接受访问令牌。** 客户端使用你在 **Access tokens** 页面签发的*访问令牌*连接。令牌可单独吊销、可按请求归因，并可限定到若干入口面与一个路由配置。一个令牌都没签发的部署无法代理任何请求。

**步骤 2 — 启动服务：**

```shell
docker compose up -d
```

入口脚本会在服务器启动前应用待执行的 Prisma 迁移和种子数据。随后服务器在 `http://127.0.0.1:3456` 监听。用浏览器打开该地址，在 **Providers** 与 **Routing** 页面完成配置，然后在 **Access tokens** 签发一个令牌——客户端要用的就是它。

**步骤 3 — 把 Claude Code 指向网关：**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

或写入 shell 配置文件长期生效：

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**步骤 4 — 为你使用的入口面开启路由：**

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

在 **Providers** 页面点击 **Add provider**，选择一个厂商（Anthropic、OpenAI、DeepSeek、Gemini 等），粘贴 API Key，并选择要启用的模型。密钥存放在数据库中，而不是 `config.json`；只有在这里开启的模型才能成为路由目标，其余模型仍会列出，以便日后启用。

### 订阅型提供商（Claude Code 与 Codex）

Rialto 可以在没有逐次调用 API Key 的情况下经由订阅型提供商路由。在 **Providers → Add provider** 添加一个。两家厂商的 OAuth 客户端回跳地址不同，所以认证步骤提供的方式按厂商区分。

**Claude**

- **Sign in with Anthropic** — 在浏览器中打开 Anthropic 的 OAuth 页面，回跳到 `http://localhost:3456/callback`。
- **粘贴重定向 URL** — 当浏览器到不了那个回调地址时（Rialto 在隧道之后，或是无头机器），把 Anthropic 重定向到的 URL 复制下来粘贴进输入框；授权码交换在服务端完成。
- **Import from Claude** — 从已登录过的机器上传 `~/.claude/.credentials.json`。

**Codex**

- **Device code**（默认）— Rialto 显示一次性代码和链接 `https://auth.openai.com/codex/device`。在任意浏览器打开该链接，登录 ChatGPT 并输入代码，页面会自动进入下一步。代码 15 分钟后过期。整个过程不需要任何连接回到 Rialto，因此在隧道之后或容器内同样可用。它与 `codex login --device-auth` 使用的是同一流程（`POST /api/oauth/device/start`，随后 `POST /api/oauth/device/poll`）。
- **Import from Codex** — 从已登录过的机器上传 `~/.codex/auth.json`。

不提供 Codex 的浏览器登录：其 OAuth 客户端只会跳回*浏览器所在机器*上的 `http://localhost:1455/auth/callback`，远程或容器中运行的 Rialto 永远收不到。其背后的回环监听器（端口 `1455`，`compose.yaml` 仍然发布）已不再被 UI 使用。

Rialto 会保存加密后的令牌并负责刷新。一个提供商可以持有多个账户，由哪个账户处理请求按每个请求决定（见[故障切换与账户轮换](#故障切换与账户轮换)）。Subscriptions 列表上有一个 **Refresh** 按钮（`POST /api/subscriptions/refresh`），它会重新同步已启用订阅型提供商上的每个账户，并越过 5 分钟缓存重新拉取用量。路由会立即读取新数值，而不必等下一次调度器 tick：刷新会重新发布配额快照，并解除此前 429 留在某账户上、而厂商已为其重置的耗尽标记。

Codex 账户可以持有*积攒的*速率限制重置。提供商页面上的账户行会显示剩余次数，**Use reset** 会使用一次（`POST /api/subscriptions/accounts/{id}/reset-usage`），使用前的确认会显示下一次到期的时间。只有厂商会接受重置时——也就是某个窗口已用尽时——按钮才可用。随后该账户的用量会按与刷新相同的路径重新读取，因此重置一生效，路由就会重新使用该账户。重置永远不会被自动使用。

> **服务条款提示：** 使用 Claude Code 订阅来服务 Claude Code 以外的应用程序，可能违反 [Anthropic 的使用政策](https://www.anthropic.com/legal/aup)。是否使用该功能请自行判断并承担风险。

## 🚪 入口面（inbound surface）

Rialto 不只是 Claude Code 的代理。入口处接收四种线路格式，每一种都由 `src/llms/inbound/surfaces.ts` 中的单个描述符定义：

| 入口面 | 路径 | 典型客户端 | 凭据 | 错误信封 |
|---|---|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | Claude Code | `x-api-key` 或 `Authorization: Bearer` | `{type:'error', error:{type,message}}` |
| `openai-chat` | `POST /v1/chat/completions` | OpenAI SDK、Cline、OpenWebUI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `openai-responses` | `POST /v1/responses` | Codex CLI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `gemini-generate` | `POST /v1beta/models/<model>:<action>` | Gemini CLI | `x-goog-api-key`、`?key=` 或 `Authorization: Bearer` | `{error:{code,message,status}}` |

`GET /v1/models` 与 `POST /v1/messages/count_tokens` 是目录读取而非补全面，因此不属于这四个面——但它们按调用方 SDK 的凭据约定和错误信封作答，限定到部分入口面的令牌仍可调用它们。

无论请求落在哪个入口面，凭据都必须是**签发的访问令牌**，不接受其他任何凭据。

### 路由模式

每个入口面都有一个已存储的模式：

| 模式 | 行为 |
|---|---|
| `passthrough` | 模型由调用方指定。路由被跳过。 |
| `routed` | 按场景路由：场景与通道 → 通过全部门槛、按节奏排序后的第一条路线 → 故障切换。 |

**所有入口面初始都是 `passthrough`。** 对一个尚未配置的部署做路由毫无意义——没有路线时，每个请求都会径直落回调用方自己的模型——因此路由是在有了可路由目标之后，按入口面逐个开启的。每个入口面从一个路由配置取路线（默认为 `live`）；Routing 页面的路由配置选择器可以把比如 CI 客户端所用的那个面指向 cost-first 的路由配置。第二个路由配置通过写入即可创建：`PUT /api/routing/profiles/<key>`。两种模式各自如何处理 `body.model`，见[按场景路由与直通](#按场景路由与直通)。

## ⚙️ 配置

### 磁盘配置（`~/.rialto/config.json`）

存储启动时的标量值和磁盘常驻对象。支持环境变量插值（`$VAR` / `${VAR}`）和 JSON5 注释。**没有备份**：每次保存都会原地覆盖文件，唯一的安全网是无法解析的文件会被改名放到一旁（`config.json.invalid-<timestamp>`）而不是删除。schema 未声明的键会被保留而不是丢弃。

| 键 | 说明 |
|----|------|
| `HOST` | 监听地址（默认：`127.0.0.1`）|
| `PORT` | 监听端口（默认：`3456`）|
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access 团队域名。与 `ACCESS_AUD` 一起校验 `/api/*` 的 assertion |
| `ACCESS_AUD` | Access 应用的 AUD 标签。**两者都设置才会生效** |
| `LOG` | `true` 以写入日志文件（默认 `false`）|
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace`（默认 `info`）|
| `LOG_MAX_MB` | 日志文件轮转的大小（MB，默认 `10`）|
| `PROXY_URL` | 上游 API 请求的 HTTP 代理 |
| `API_TIMEOUT_MS` | Bun 的逐请求空闲超时（ms）：换算为秒并夹到 1–255 秒（默认 255 秒）。它不是上游调用超时 |
| `CLAUDE_PATH` | 已声明、可编辑，但本版本中没有任何代码读取它——没有 CLI |
| `NON_INTERACTIVE_MODE` | 已声明、可编辑，但本版本中没有任何代码读取它 |
| `CAPTURE_REQUESTS` | 为每个请求记录一行 `RequestLog`（默认 `true`）|
| `CAPTURE_MESSAGES` | 归档对话记录（默认 `true`）|
| `REDACT_TOOL_ARGUMENTS` | 从归档中剔除工具调用参数（默认 `false`——开启后丢失的信息无法恢复）|
| `ROUTING_SCHEDULER_INTERVAL_MS` | 调度器 tick 间隔，60 000–3 600 000（默认 `300000`）|
| `Personas` | 人格库（数组）|
| `ActivePersona` | 当前人格的 uuid id；`null` / 缺失 / 空字符串表示无。在 `/api/config` 的线路上同样是顶层键 |
| `StatusLine` | 在 Settings → Status line 编辑的状态栏布局。仅供预览：本版本中没有任何代码渲染它 |

上表中的标量键（除 `Personas`、`ActivePersona`、`StatusLine` 之外）也可以作为进程环境变量提供——例如 Docker 的 `environment:` 条目——已设置的环境变量优先于文件。

旧版本为已不存在的机制写下的键一律忽略。`Router`、`CUSTOM_ROUTER_PATH`、`LiveRoutingName`、`CROSS_PROVIDER_FALLBACK` 以及已废弃的管理密钥 `APIKEY` 会在每次读取时被剔除；`POST /api/config` 会带着警告丢弃它们，下一次保存时把它们从文件中清掉。`APIKEY` 环境变量同样不会被读取。`ROUTER_MODE` 只是作为未知键留在文件里，没有任何代码读取它。

### 提供商、模型与路线（数据库）

提供商、模型、层级别名、每个路由配置的路线以及每个入口面的路由模式存放在 PostgreSQL 中，通过 Web 界面（`POST /api/config`、`PUT /api/providers/{name}/tier-aliases/{tier}`、`PUT /api/routing/profiles/{key}`、`POST /api/inbound-surfaces`）管理。`config.json` **内部**的 `Providers` 键是每次保存后从数据库回写的单向镜像——手工修改不会产生任何效果，并会在下一次写入时被覆盖。路由相关的内容不再镜像到磁盘。

### 按场景路由与直通

这是 Rialto 对 `body.model` 会做的仅有的两件事。

**按场景路由**（`routed`）。请求经由一个路由配置进行路由——访问令牌指定了就用它的，否则用入口面的，再否则用 `live`——并被归入一个*场景*和一个*通道*：

- 输入超过 [Long context 阈值](#long-context-阈值)时为 **Long context**；否则请求要求思考时为 **Think**（Anthropic 的 `thinking` 只要不是 `disabled`，OpenAI 的 `reasoning_effort` / `reasoning` 只要不是 `none`，Gemini 的 `thinkingConfig`）；两者都不是则为 **Default**。
- 请求带有[子代理标签](#子代理标签)时走 **Subagent** 通道，否则走 **Agent** 通道。

调用方发送的模型名不决定任何事。路由配置为每个场景和通道各持有一组有序的路线，每条路线点名一个提供商及其上的一个层级（`claude-code · sonnet`）；它此刻对应哪个模型，由该提供商的[层级别名](#层级别名)决定。Think 或 Long context 的列表在该通道上若没有任何可用路线——已启用、别名已设置、且到达的模型已启用——就交给同一通道的 Default 列表处理。

路线按顺序尝试，只有通过全部门槛的路线才能处理请求：

1. 路线本身、它的模型和提供商都已启用；
2. 该提供商为路线所点名的层级设置了别名；
3. 若请求携带网页搜索工具，模型必须能执行它——Anthropic、OpenAI Responses 与 Gemini 的请求形状能承载它，Chat Completions 不能；
4. 模型的上下文窗口装得下这段提示（窗口未知则放行）；
5. 配额未耗尽：没有此前 429 留在该模型或其提供商上的耗尽标记，且路由调度器的快照没有报告它已用尽、或已用量达到配置的 `quotaSkipPct`（只有订阅型目标才有读数）；
6. 最近 5 分钟的错误率低于 `errorRateSkipPct`（样本数达到 `minHealthSamples` 之后才判断）。

通过的路线随后按**节奏**重新排序——按当前的用量速度，各路线的订阅配额在重置时会用到多少。预计不到预算 60 % 就会结束的路线移到最前，免得付费的配额被浪费；预计会超过 100 % 的路线移到最后，让你写在它下面的路线在触及上限之前先承接流量；其余路线，以及没有读数的 api_key 路线，保持你写的顺序。所有路线都超出节奏时，保持你写的顺序——仅凭预测不会拒绝请求。排在第一的路线成为 `body.model`，其余按该顺序作为兜底列表随行。一条都没通过时，由原因决定应答：

| 情形 | 应答 |
|---|---|
| 该通道的 Default 列表没有路线，或所有路线或其目标都已关闭 | 调用方自己的 `body.model` 按原样送出。无论 `exhaustedBehavior` 是什么，**永远不会返回 429**——未配置的列表是「没有意见」 |
| 至少有一条路线因配额或错误率被拦下 | 按 `exhaustedBehavior`：`429`（默认）不触碰任何上游，返回 `rate_limit_error` 和 `Retry-After` 头——距被拦下的路线中最早恢复者的秒数（取其 429 标记的截止时间，否则取快照中的重置时间；都未知时为 30）；`passthrough` 则改为发送调用方自己的 `body.model`，且没有兜底。因配额被拦下的 Think 或 Long context 列表不会借用 Default 的路线 |
| 没有路线因配额被拦下，但没有一条路线能接下*这个*请求——别名未设置、不支持网页搜索、提示过大 | 以该入口面的错误信封返回 **400**（`invalid_request_error`，Gemini 面为 `INVALID_ARGUMENT`）。等待也改变不了什么，所以不伪装成 429 |

路由配置无法加载、或路由因其他原因失败时，调用方自己的模型按原样送出。Rialto 从不凭空编造目标，它只会把 `body.model` 替换成某条路线的模型。

路由配置还有四个约束，通过 `PUT /api/routing/profiles/{key}` 设置（Routing 页面不显示它们）：`exhaustedBehavior`（`429` / `passthrough`）、`quotaSkipPct`（默认 100）、`errorRateSkipPct`（比例，默认 0.5）和 `minHealthSamples`（默认 5）。

**直通**（`passthrough`，或被固定到保留路由配置 `passthrough` 的访问令牌）。调用方的 `body.model` 按原样送往上游：`provider,model`，或恰好只有一个已启用提供商托管的裸模型名。在这种模式下，入口面可以拒绝特定的 `provider,model` 组合（Routing → Reachable targets）。

无论哪种模式，在 Providers 页面关闭的提供商或模型都不会被派发——不会来自路线，不会来自直通请求，不会作为兜底目标，也不会经由已关闭的订阅型提供商的账户。手工点名也会被拒绝而不是转发。

处理请求的场景——或 `passthrough`——会记录在请求日志里，并在 Activity 中以 **Scenario** 列显示。完整参考见 [docs/architecture/routing.md](docs/architecture/routing.md)。

### Long context 阈值

把请求视为 Long context 的输入大小不由你设定。它的起点是 Default · Agent 中第一条可用路线所到达模型的上下文窗口的 70 %（剩下的留给回复），未知时为 128 000——因此它跟随那条路线的别名。此后路由调度器每天最多一次，按 Long context · Agent 第一条路线的节奏把它调整 20 %：那条路线预计会剩下配额时调低，让更多请求到达它；预计会用尽时调高。它不会低于 30 000，也不会高于起点——更大的请求装不进它原本会留在的 Default 模型。那条路线承受不住的调低——当天就用尽了——会被撤回。当前生效的值显示在 Routing 页面的 Long context 行上；在路由配置的约束里设 `autoTuneLongContext: false` 可以停止调整，但没有手工指定数值的办法。

### 层级别名

路线点名的是提供商和层级，而不是模型。`claude-code · sonnet` 指哪个模型，由该提供商的*层级别名*决定，在提供商页面的 **Tier aliases** 栏里为 `fable`、`opus`、`sonnet`、`haiku` 各设一个。厂商发布新的 Sonnet 时，只需挪动这一个别名，所有指向该提供商 Sonnet 的路线都会随之改变。

**别名永远不会自己移动。** 目录的 Refresh 可以发现新模型，这一栏也会把它计为候选（「1 new」），但新模型的价格、使用资格和行为，应当在所有 Sonnet 请求落到它上面之前由人来确认。在选择器里选中它并保存页面，别名就会指向它，同时该模型被启用。选择器列出的是提供商的全部模型，而不只是名字表明该层级的那些，因此模型名不带 Claude 系列的提供商——Codex、OpenAI——同样可以设置别名。

Claude 订阅型提供商在其模型创建时，会依照预设的默认模型自动获得别名，因此刚连接的 Claude 订阅即可直接路由。Codex 的模型名不带 Claude 系列，其别名需要你自己设置。

别名未设置的路线会被保留（保存时只会给出警告），但在请求时会被跳过；在 Routing 页面上，没有模型的层级无法选择。若因此 Think 或 Long context 的列表已没有可用路线，就交给 Default；若 Default 变成这样，且没有路线因配额被拦下，请求就会如上所述以 400 拒绝。

### 故障切换与账户轮换

列表的路线就是兜底列表；在同一条路线内部，先轮换订阅型提供商的账户：

- **429 时的账户轮换** — 订阅型提供商返回 429 时，会把该子账户标记为耗尽（直到某个已用满 90 % 以上的绑定窗口重置；无从得知时则为 5 分钟），并在对等账户上重试同一个目标，最多轮换 10 次。只有当对等账户全部用尽时，才会标记该模型并前进到下一条路线。OpenAI 的 `insufficient_quota` 会一次性标记整个提供商。该账户之后一旦请求成功，标记即被解除。
- **列表的顺序按你写的执行**（节奏带来的前后移动除外） — 不存在 `auth_mode` 门。订阅型路线会保留写在它后面的 api_key 路线，同一提供商的其他层级也会被遍历（耗尽是按 `(provider, model)` 标记的）。如果不想让订阅额度溢出到按量计费，就不要把 api_key 路线写在它后面。
- **多账户均衡** — 当同一提供商上启用了多个账户时，账户选择器先剔除已记录的绑定窗口已达 99 % 的账户，若粘性的会话→账户映射仍指向幸存者则复用它，否则挑选所需消耗速率最高的账户——`剩余百分比 ÷ 距离重置的小时数`，取其最紧的绑定周窗口——也就是最有可能把配额浪费掉的那一个。平局时选最久未被选中的账户。

决策会以结构化日志记录。某个列表没有可用路线时，日志会列出每条被跳过的路线及其原因——`disabled` / `alias_unset` / `no_web_search` / `context_too_small` / `exhausted` / `error_rate`——应答为 429 或 400 时以 `warn` 输出，送出调用方自己的模型时以 `info` 输出。按节奏调整了顺序、以及 Long context 阈值发生变化时，也会以 `info` 输出。

> **不存在周维度排空守卫。** 早期版本会在订阅型提供商的周窗口越过线性排空目标时提前切换。这已经删除：只有当调度器的快照报告订阅型目标已用尽——或已用量达到默认为 100 的 `quotaSkipPct`——时才会拦下它。节奏只改变仍然开放的路线的顺序；除此之外，它会一直跑到上游上限，并根据真实发生的 429 做轮换。

### 人格

*人格*是一段命名的系统提示片段，在路由之后，会被追加到每一个走路由的 `/v1/messages` 请求里。借助它可以在不修改 Claude Code 本体的前提下，让 Claude Code 始终保持某种口吻、角色或工作守则。

- **人格库** — `Personas` 是磁盘 envelope 上的顶层数组。每个条目都带有一个稳定的 uuid `id`、显示用的 `name`（无需唯一）和正文 `prompt`。新装环境会附带一个小型的初始人格库；既有环境则保留磁盘上已经存在的内容。
- **当前激活** — 每个部署最多只能有一个激活的人格。它的 uuid id 就是顶层的 `ActivePersona` 键，在磁盘 envelope 和 `/api/config` 的线路上位置相同。`null` / 缺失 / 空字符串表示「无人格」。不存在项目级或会话级的覆盖文件。
- **注入方式** — 把当前人格的 `prompt` 追加到带有 `cache_control` 的最后一个 system 块上（若没有则退回到最后一个字符串文本块）。这样人格就被收纳进缓存前缀的*内部*，既不会消耗额外的 cache 断点，又能在多次请求之间保持字节级稳定（保留 Anthropic 的 prompt cache）。当 `system` 为字符串 / 未定义时进行拼接；多块数组形式则原地修改。
- **入口面限制** — 人格注入**只在 `/v1/messages` 上运行**，而且只对 routed 流量生效：passthrough 入口面，或固定到 `passthrough` 路由配置的令牌，会跳过路由，人格也随之跳过。OpenAI 兼容面与 Gemini 面根本不接受被撑大的 `system` 字段（Codex 会返回 `Unsupported parameter: system`），因此宁可跳过注入也不让请求失败。在 `/v1/messages` 上，每个走路由的请求都会继承当前人格，无论由哪条路线处理——包括没有路线、按调用方自己的模型送出的请求。
- **与子代理交互** — 人格注入在子代理标签被剥离*之后*执行，所以子代理的逐次系统内容不会被覆盖，而是与人格合成。

人格库的管理和当前激活人格的切换都在 **Settings → Personas**（`/settings/personas`）。「无人格」是默认的 no-op。

关于如何撰写高还原度的人格（结构模板、反模式列举、思考过程控制），请参见 [docs/guides/persona-authoring.md](docs/guides/persona-authoring.md)。

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

没有任何可按提供商配置的转换器设置。推导出的链以只读形式显示在 Providers 页面的 **Request shape** 中，请求异常时应首先查看这里。

### 子代理标签

位于第二个 system 块开头的子代理标签，会把该请求分到 **Subagent** 通道：

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

只看是否存在，内容被忽略。带标签的请求由其场景的 Subagent 列表处理——子代理该用哪个模型写在这里，而不是写进每个提示词文件——该列表没有可用路线时落到 Subagent 的 Default 列表，而不会走 Agent 通道；Subagent 的 Default 也为空时，按调用方自己的模型送出。标签也会记录到请求日志中，以便在 Activity 里区分子代理流量。无论哪种路由模式（包括直通），标签都会在请求发往上游之前被剥离，因此这个内部标记不会到达厂商。标签是从 Anthropic 形状的 `system` 中读取的，所以 OpenAI 面和 Gemini 面的请求总是走 Agent 通道。

`<CCR-SUBAGENT-MODEL>` 是改名前的写法，因为它存在于人们已经写好的提示词里，所以仍会被识别并剥离。标签正文里仍写着旧的 `provider,model` 组合也无妨——只是那个组合不会被读取而已。

## 🔀 OpenAI 兼容与 Gemini 兼容入口面

任何 OpenAI SDK 调用方（Codex CLI、Cline、OpenWebUI、Python / JS 的 `openai`、`curl`）以及任何 Gemini SDK 调用方，都可以像使用普通厂商端点那样消费你的**订阅额度**（Claude Max、ChatGPT Plus/Pro）。调用方看到的是普通的请求 / 响应；在 Rialto 背后，请求会被送往你已完成 OAuth 认证的账户，因此费用留在月度订阅内，而不是走按量计费的 API 账单。

### 端点（OpenAI 线路形状）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/v1/models`             | 以 `{object:'list', data:[…]}` 返回已启用且可路由的模型。每个 `id` 都是 Rialto 的规范 `provider,model` 形式，可直接用于下一次调用；`owned_by` 是提供商名。 |
| `POST` | `/v1/chat/completions`   | 标准 Chat Completions——支持流式与非流式。body 的 `model` 字段接受 `/v1/models` 返回的 `provider,model` id。 |
| `POST` | `/v1/responses`          | OpenAI Responses API——支持流式与非流式。模型寻址方式同上。 |

这三个路径的认证**仅接受 `Authorization: Bearer <签发的访问令牌>`**（`x-api-key` 属于 Anthropic 的约定，在这里会被拒绝；401 的响应体遵循 OpenAI 的 `{error:{message,type,code}}` 形状）。Anthropic 面（`/v1/messages`）额外读取 `x-api-key`，但其取值同样必须是签发的访问令牌。

### 示例 — 用 OpenAI Python SDK 调用你的 Codex 订阅

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="rialto_your-access-token",   # Access tokens 页面签发
)

# 1. 列出可路由的模型
for m in client.models.list().data:
    print(m.id, m.owned_by)
# → codex,gpt-5.5  (owned_by=codex)
# → claude-code,claude-sonnet-5  (owned_by=claude-code)
# ...

# 2. Chat Completions（经由你的 Codex Plus/Pro 订阅路由）
res = client.chat.completions.create(
    model="codex,gpt-5.5",
    messages=[{"role": "user", "content": "reply pong"}],
)
print(res.choices[0].message.content)  # → pong
```

### 示例 — OpenAI JS SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: process.env.RIALTO_ACCESS_TOKEN, // Access tokens 页面签发
})

const stream = await client.chat.completions.create({
  model: 'codex,gpt-5.5',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

任何支持覆盖 `base_url` / `baseURL` 的客户端都同理。

**这些入口面上哪些能力生效。** 故障切换、账户轮换以及 `provider,model` 寻址始终生效。按场景路由只有在把该入口面从 `passthrough` 切换为 `routed` 之后才生效——而且此时客户端发送的模型名（`codex,gpt-5.5`、`gemini-2.5-pro`）不决定任何事：要求推理的请求（`reasoning_effort`、`reasoning`、`thinkingConfig`）走 Think 列表，长请求走 Long context 列表，其余走 Default 列表，都在 Agent 通道上。多个入口面共用一个路由配置时也共用其列表，想让某个面走不同的路线，就给它指向专用的路由配置。人格注入**不**生效——它只作用于 `/v1/messages`（见上文「人格」）。

## 📊 日志

只有一个日志器（pino），它记录全部内容——HTTP 请求、路由决策、上游调用、服务器事件：

- **控制台** — 始终输出，经过美化。
- **文件** — `~/.rialto/logs/rialto-YYYY-MM-DD.log`，仅当 `LOG` 为 `true` 时写入（默认为 `false`）。超过 `LOG_MAX_MB`（默认 10）的文件会续写到 `rialto-YYYY-MM-DD-N.log`。级别由 `LOG_LEVEL` 控制；密钥（`authorization`、`x-api-key`、令牌、cookie）在写入前会被脱敏。

这些文件可以在界面的 **Activity → Logs** 中查看。不存在单独的应用日志。

## 🌐 对外公开部署

通过隧道公开 Rialto 时，`/api/*` 与 `/v1/*` 必须区别对待——前者置于 Cloudflare Access 之后，后者在边缘放行、仅由签发的令牌把守。完整的配置步骤，以及会让 CLI 客户端卡在登录页的那些失败模式，见 [docs/guides/public-deployment.md](docs/guides/public-deployment.md)（日文）。

**被锁在门外时**（Access 故障或配置错误、`config.json` 被隔离、Postgres 宕机），没有可以依靠的管理密钥——也不需要。SSH 登录宿主机并转发端口，然后打开 `http://localhost:3456`：

```shell
ssh -L 3456:localhost:3456 <host>
```

在宿主机本机发出的请求不受管理网关限制，而这项判断既不读取 Access，也不读取数据库。使用 Docker 时，把端口发布到宿主机上（回环地址即可），做法相同。唯一会关上这扇门的设置是 `RIALTO_TRUST_LOCAL=false`。

## ⬆️ 从改名前的版本升级

主目录、环境变量、数据库名、Docker 镜像以及 thinking signature 前缀都随着改名为 Rialto 而变化，早期版本的槽位 / 规则 / 预设路由也已合并为链与直通。此后，按场景划分的模型链又变成了按场景划分的「提供商 · 层级」路线列表。v2.89.0 走过一段弯路——它按请求模型的层级路由，并且只转换了 `default` / `agent` 链——本版本回到按场景路由：首次启动时，`db seed`（容器入口脚本会执行它）会把每个路由配置的 `default` / `think` / `longContext` 链（两个通道都包括）转换为层级别名和路线，每个配置只转换一次。在 v2.89.0 的 Routing 页面上编辑过的路线不会被带过来，网页搜索与图像的列表只记录条数，不做转换。请参见 [docs/guides/migration-v3.md](docs/guides/migration-v3.md)（日文）。

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
bun run test:e2e          # 针对已在运行的 dev 服务器的浏览器测试；
                          # :16175 无响应或缺少 chromium 时自动跳过
bun run browser:install   # 供 test:e2e 使用的 playwright chromium
```

`bun test` 与 `bun run test` 是**两个不同的命令**。CI（`.github/workflows/ci.yml`）会跑五个作业：Commit Lint、Biome Check、Type Check、Test、Build。

### 检查

```shell
bunx tsc --noEmit         # CI 运行的是 `bunx tsc -b --noEmit`
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
| `bun run db:seed` | 幂等的种子数据——`live` 路由配置，在你添加之前没有路线；同时把各配置旧有的模型链按配置一次性转换为按场景的路线 |
| `bun run db:seed:demo` | 仅供开发的各页面演示数据；`-- --clean` 可将其移除。见 [docs/guides/demo-data.md](docs/guides/demo-data.md) |
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

打上 `v*.*.*` 标签后，会为 `linux/amd64` 与 `linux/arm64` 构建并发布 `ghcr.io/tkgstrator/rialto`（`.github/workflows/docker-publish.yml`）。下面的脚本是手动构建同一镜像的路径：

| 脚本 | 用途 |
|------|------|
| `bun run release` | 先 `bun run build`，再构建 Docker 镜像并推送到 GHCR |
| `bun run release:docker` | 仅构建并推送 Docker 镜像 |

### 架构文档

- [`docs/architecture/inbound-surfaces.md`](docs/architecture/inbound-surfaces.md) — 入口面注册表，以及由它推导出的一切
- [`docs/architecture/inbound-parity.md`](docs/architecture/inbound-parity.md) — 哪个功能在哪个入口面上生效
- [`docs/architecture/routing.md`](docs/architecture/routing.md) — 按场景与提供商层级的路由：数据模型、门槛、节奏、结果、Long context 阈值、配额快照、模型发布的处理
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — 启动 → 请求 → 上游 → 响应整形的完整链路
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — 路由决策与 429 轮换的放大图
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — 测试在哪里、覆盖了什么
- [`docs/guides/pwa.md`](docs/guides/pwa.md) — 安装为应用 / PWA 的行为

## 许可证

MIT — 参见 `LICENSE`。
