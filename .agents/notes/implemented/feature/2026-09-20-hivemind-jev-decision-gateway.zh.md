# Agent Note: HIVE-MIND Jev 决策网关

Status: implemented

[English](2026-09-20-hivemind-jev-decision-gateway.md) | 中文

## 问题

HIVE Chat 会提供稳定的 HIVE 记忆网关和连接应用网关，但聊天模型此前在知道请求需要哪种能力之前，就会同时收到两个 schema。使用聊天模型本身执行初步选择会重复消耗提示词和 schema token。若用工作流规划器替换 Harness 循环，则会牺牲其渐进式、由回执驱动的行为，并产生第二个执行权威。

## 决策

HIVE Chat preset 在 HIVE 记忆工具和连接应用工具之后挂载 `@deepseek-ai/dsh-hivemind-decision-gateway`。该插件在 `agent/pre-step` 阶段、提示词和工具组装之前调用经过身份验证的 Core 决策端点。

它不是规划器。它只为已接纳的用户消息选择第一个能力类别。active 模式为该模型请求施加 Cordis 作用域工具限制；shadow 模式只记录决策；off 模式不注册监听器。下一次 pre-step 会解除该限制。

Core 负责提供方凭据、置信度和差值阈值，以及类型化的 Jev 合同。Runner 不发送租户标识；其短时有效的服务 token 在 Core 侧提供身份。提供方错误、超时、无效响应、低置信度、所选工具缺失以及 Core defer 都会在同一轮中保留现有 Harness 工具表面。

决策以 `hivemind/decision` 追加。模型可见的精确工具表面仍可通过普通 request header 重建。工具参数、授权、审批、执行、回执和继续运行仍由现有插件及未修改的 Agent 循环负责。

## 考虑过的替代方案

**确定性 DAG 规划器。** 已拒绝，因为它会重复 Harness 模型对依赖步骤的渐进式控制，并让第二个组件负责工作流顺序。

**让每个运行时直接调用 Jev。** 已拒绝，因为它会在 Legacy 和 Runner 中重复提供方凭据、阈值和结果校验。Core 是唯一的提供方边界。

**修改 Agent 循环。** 已拒绝，因为 Cordis 已提供带作用域的 `agent/pre-step` 和工具限制 seam。修改循环会把该优化与所有 Harness profile 耦合。

## 影响

第一个模型请求可以只携带所选现有网关的 schema，同时普通选择器仍是即时 fallback。shadow rollout 不会改变模型可见行为。代价是在第一次模型调用前增加一个有界的决策请求；并且在后续阶段消费者采用同一个类型化 Core 合同之前，继续步骤目前会返回完整的现有选择器。
