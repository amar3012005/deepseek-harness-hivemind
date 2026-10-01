# @deepseek-ai/dsh-hivemind-web-runner

[English](README.md) | 中文

嵌入式 HIVE 聊天专用的主机插件。本地验证有效期为 60 秒的 HMAC-SHA256 引导票据，在共享的 `hive:harness-ticket:` 命名空间下使用原子 `GETDEL` 消费 Redis `jti`，签发带 `Secure; HttpOnly; SameSite=None` 的原生 Connection Cookie，不向浏览器返回 bearer token。`/health` 检查 Redis 与 PostgreSQL 可达性，不伪造租户作用域。

票据密钥和 Redis URL 从指定环境变量读取，因此解析后的配置输出不会包含凭证。父页面来源以明确允许列表注入 SPA；票据声明保留在服务器。

`GET /api/hivemind/employees` 使用现有经过认证的 Connection 主体以及短期运行器到控制平面令牌。它仅返回获授权的员工 ID、姓名、角色、头像 URL 与状态，供 HyperAgents 选择器使用；匿名请求默认拒绝。无需改动 Core 或 Da-vinci 前端。

## 实时语音

输入框波形按钮通过 WebRTC 启动 GPT-Live，使用服务器的原生 `openai-codex` 凭证。听写仍然可用；输入文字时使用普通发送箭头。`liveVoice` 默认对所有经过认证的 HIVE 租户启用桥接，模型为 `gpt-live-1-codex`，订阅音色为 `cove`。默认房间生命周期为 15 分钟；服务器允许每位用户一个房间，最多同时 20 个房间。缺少授权时默认拒绝。

`POST /api/hivemind/voice/start` 接受 `{sessionId,sdp}`，仅返回 `{id,sdp}`。请求必须具有 Connection Cookie、同源 JSON，以及调用者组织可见的 Session。OAuth 令牌保留在服务器，通过原生凭证服务刷新。音频在浏览器与 OpenAI 之间直接流动；服务器保留经过认证的控制通道。

语音接收部署人格、精简用户与组织资料，以及有界的近期对话上下文。运行时在用户语音轮次和委派前刷新资料。每次委派查询或操作均使用现有 Session 的 Agent 和工具，保留其访问模式、审批规则、连接器作用域和持久化回执。语音不会创建第二个 Codex 任务 Agent，也不会授予额外的公司记忆权限。

`POST /api/hivemind/voice/stop` 接受 `{id}`。结束语音或离开 Session 时停止麦克风轨道、关闭媒体连接与控制通道、移除事件监听器，并将已完成的对话保留为原生上下文。关闭语音后，已接受的 Agent 工作仍可在文字对话中访问。

订阅传输是实验性的，其协议版本固定为 Codex v3 客户端委派契约（`OpenAI-Alpha: quicksilver=v2`）；音色值必须与该订阅路由兼容。修改契约需要再次执行实际音频与委派探测。接入成功本身不能证明音频或委派工具执行正常。

## 已知限制与延后工作

- 订阅语音需要已授权的服务器凭证和兼容的实验性传输；缺少授权时默认拒绝。
