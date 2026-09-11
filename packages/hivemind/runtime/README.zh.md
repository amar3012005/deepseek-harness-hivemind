---
description: "面向 DeepSeek Harness 的 HIVE-MIND 身份、公司上下文、记忆召回和 HyperAgent 发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hivemind-runtime

[English](README.md) | 中文

## 摘要

`dsh-hivemind-runtime` 将 Harness 代理绑定到 ICARUS 保存的 HIVE-MIND 身份。它验证本地凭据，在服务器端解析用户和组织范围，并注入精简公司简介。HIVE 模式暴露一个渐进式元工具，保留最近完成的用户请求和最终回答，并从后续模型请求中移除旧工具载荷。凭据和租户标识不会进入模型可见的 schema 或结果。

## 使用此包

在提供 `tools` 和 `skills` 的代理预设中挂载此插件：

```yaml
- insert:
    - id: hivemind-runtime
      name: '@deepseek-ai/dsh-hivemind-runtime'
      config:
        agentFeaturesEnabled: true
        legacyToolsEnabled: false
        icarusConfigPath: '~/.icarus/config.json'
        requestTimeoutMs: 20000
        responseMaxBytes: 2097152
        profileContextMaxChars: 12000
        profileBriefMaxChars: 1200
        recallResultLimit: 5
        recallItemMaxChars: 16000
        historyTurns: 5
        historyMaxChars: 8000
```

ICARUS 凭据必须是当前用户拥有且组或其他用户不可写的普通文件。运行时仅接受 `https://core.singulancelabs.com` 或 loopback API 来源，拒绝重定向，限制响应体，并应用明确的请求超时。

## 语义

运行时组合三个可独立测试的能力：`hivemind-context` 负责等待式提示投影，`hivemind-memory` 负责模型可见工具，`hivemind-employee-directory` 验证准确的组织 HyperAgent 档案。在用户消息唤醒代理之前，作用域轮次策略会隐藏该请求不需要的 HIVE 自有路由器。问候和直接档案问题不会收到路由器，普通公司工作收到 `hivemind_meta`，连接应用工作可以同时收到 `hivemind_meta` 与 `hivemind_connected_task`；该策略绝不改变原生 Harness 工具。限制在轮次的所有步骤中保持，并在轮次停止时解除。历史投影在 `historyMaxChars` 内最多保留 `historyTurns` 个完成的用户请求和最终助手回答；推理、工具调用和工具输出保留在仅追加日志中，但不会进入后续模型请求。

`hivemind_meta` 支持 `context`、`recall` 和 `profiles`。召回暴露一个去重后的前五条结果，保留重要内容和引用元数据，并将每条证据限制在 `recallItemMaxChars` 内。其聚焦 schema 支持来源、项目、时间、显式标签、媒体类型、文件名和实体过滤器。任何操作都不接受用户或组织标识。

## 模型体验

模型看到一条精简组织消息、最近完成的对话，以及在提示组装前选定的 HIVE 自有路由器 schema。详细的公司大脑指令保持注册供用户明确调用，而不会出现在每个模型技能目录中。初始简介受 `profileBriefMaxChars` 限制；直接身份请求无需依赖模型选择工具即可获得有界的已验证档案上下文，其他详细公司工作通过 `context` 加载。当前轮次的工具结果可用于综合，并由历史投影从后续轮次中移除。

## 已知限制和延后工作

- 该集成为只读能力：员工执行和连接应用操作仍是独立能力。
- 浏览器身份验证使用本地 ICARUS 配置，而不是托管式多租户凭据服务。
- 超出首批前五条结果的渐进式召回分页尚未实现。

## 开发说明

源包负责身份支持的组合和本地连接路由。不要把凭据和租户权限放入浏览器代码、工具参数或模型可见结果。
