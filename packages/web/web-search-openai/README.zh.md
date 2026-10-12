# @deepseek-ai/dsh-web-search-openai

[English](README.md) | 中文

面向 `ctx.web` 的原生 Cordis 提供方，注册名为 `openai-responses`。HIVE Web 配置默认禁用，须明确启用；用户或代理无需配置连接应用。所属子系统为 [Web](../../../docs/subsystems/web.zh.md)。

## 配置

| 设置 | 默认值 | 契约 |
|---|---|---|
| `transport` | `codex` | 使用现有 Codex 订阅授权；`responses` 使用单独授权的公开 Responses 令牌。 |
| `model` | `gpt-6-luna` | 账户支持的辅助搜索模型。 |
| `timeoutMs` | `12000` | 包括凭据查找的整个主要操作，范围 1000–30000 毫秒。 |
| `accessTokenEnv` | `OPENAI_SEARCH_ACCESS_TOKEN` | 仅供 `responses` 使用的凭据引用，每次请求动态解析。 |

Codex 身份验证使用与 Prime Agent 相同的原生 `llm-pi-ai/openai-codex` 授权及 pi-ai 刷新路径。Harness 凭据提供方负责原子持久化并串行更新轮换令牌；现有授权流程支持浏览器或设备登录。不要将令牌写入配置 YAML、源码、镜像、会话或浏览器响应。公开 Responses 令牌和 Codex 订阅令牌不同，改变传输不会转换凭据。

Codex 搜索使用目录传输地址 `https://chatgpt.com/backend-api/codex`，公开 Responses 使用 `https://api.openai.com/v1`。两者均发送新鲜、无状态搜索，设置 `store: false`，使用流式输出及唯一原生 `web_search` 工具。不转发记忆、连接器载荷、对话历史或客户认证令牌，仅发送明确查询。携带凭据的搜索请求拒绝重定向，不自动重试。

## HIVE 组合和回退

`hivemind_web_search` 保留现有身份和权限政策，`nativeWebSearch` 默认为 `false`。启用需激活插件、在 `web` 选择 `openai-responses`，并在目标预设设置 `nativeWebSearch: true`。启用后先调用选定的原生提供方；缺少授权、上游错误、不完整流、空结果或主要期限到达时，回到现有租户认证网络任务服务，保留该服务配置的搜索后端。用户取消不会开始回退。主要期限在工具现有六十秒预算内为回退任务留出时间。

原生 `web_search` 也通过 `ctx.web` 使用该提供方，其使用者正常报告提供方错误。租户网络任务回退属于 `hivemind_web_search`，因为它需要认证 HIVE 权限，不能由全局提供方捕获。HyperAgent 远程研究任务保留现有持久任务契约。

仅发布包含完成的搜索调用和真实来源 URL 的已完成响应。来源来自原生引用和已查阅 URL，不来自模型编写的 JSON。引用 URL 排在其他已查阅 URL 前，去重并遵守请求数量限制。`content` 限制为 12000 字符，使用者应将来源 URL 渲染为可点击引用。

不含秘密的 `web/openai-search-request` Session 事件记录准确的辅助模型输入；`hivemind/web-search-route` 记录选择原生搜索还是现有服务。不持久化授权令牌或原始上游错误。

## 模型体验

### 辅助搜索请求

#### 模型看到的内容

一个用户查询、稳定精简的指令及一个原生搜索工具。该模型独立于对话模型，不能遵循检索网页中的指令。

#### Token 影响

请求搜索时产生一次辅助模型操作。较少搜索上下文和精简回答减少提供方及对话令牌；无关对话回答前不会强制搜索。

#### KV Cache 影响

指令和工具定义稳定，查询变化；不同搜索或租户间不共享历史响应或对话状态。

### 对话结果

#### 模型看到的内容

有界来源 URL、标题、可选摘要和日期，以及可选精简搜索总结。工具保留现有结果封装和权限政策。

#### Token 影响

进入对话上下文的数量最多为请求来源数和有界总结。提供方失败时转到现有搜索服务，不额外要求对话模型修复一轮。

#### KV Cache 影响

提供方选择不增加持久提示块或额外工具 schema。

## 已知限制和延后工作

账户、模型访问及原生搜索权益须在运行器成功授权。开发者机器保存授权不能证明生产已获授权。插件不重新分发凭据，也不会把个人订阅转换为客户权益。公开 Responses 令牌刷新由外部凭据发行者负责。原生直接调用者不获得租户网络任务回退，该能力属于认证 HIVE 工具。

本包没有 `./invariant` 导出，因为它不引入需要核对的独立持久投影。Session 请求和结果使用现有持久所属服务。
