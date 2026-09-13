---
description: "面向 DeepSeek Harness 的 HIVE-MIND 身份、公司上下文、记忆召回和 HyperAgent 发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hivemind-runtime

[English](README.md) | 中文

## 摘要

`dsh-hivemind-runtime` 将 Harness 代理绑定到 ICARUS 保存的 HIVE-MIND 身份。它验证本地凭据，在服务器端解析用户和组织范围，并仅在模型请求时加载已认证的档案证据。HIVE 模式暴露有界的直接工具和一个按需能力目录工具，保留最近完成的用户请求和最终回答，并从后续模型请求中移除旧工具载荷。凭据和租户标识不会进入模型可见的 schema 或结果。

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
        reasoningPolicyEnabled: true
```

ICARUS 凭据必须是当前用户拥有且组或其他用户不可写的普通文件。运行时仅接受 `https://core.singulancelabs.com` 或 loopback API 来源，拒绝重定向，限制响应体，并应用明确的请求超时。

## 语义

运行时组合三个可独立测试的能力：`hivemind-context` 负责等待式提示投影，`hivemind-memory` 负责模型可见工具，`hivemind-employee-directory` 验证准确的组织 HyperAgent 档案。第一步模型请求只获得系统契约、有界的已完成对话，以及当前未完成工作流状态。已注册的直接工具仍然可用，但原生技能目录暂不提供。需要详细执行手册时，模型调用 `hivemind_capabilities`；下一次原生 Harness 步骤会获得当前目录，模型再加载一个相关技能。该流程不使用提示关键词分类器，也不修改原生规划器、工具注册表或代理循环。历史投影在 `historyMaxChars` 内最多保留 `historyTurns` 个完成的用户请求和最终助手回答；推理、工具调用和工具输出保留在仅追加日志中，但不会进入后续模型请求。

`hivemind_meta` 支持 `context`、`entities`、`recall`、`save` 和 `profiles`。`entities` 通过已认证的 Core 实体清单解析不完整或有歧义的命名对象，随后将选中的 `canonical_name` 传给 `recall.entities`。对象名称已经明确时会跳过该操作，也不会把它作为每次召回的强制前置步骤。召回暴露一个去重后的前五条结果，保留重要内容和引用元数据，并将每条证据限制在 `recallItemMaxChars` 内。其聚焦 schema 支持来源、项目、时间、显式标签、媒体类型、文件名和实体过滤器。任何操作都不接受用户或组织标识。

启用 `reasoningPolicyEnabled` 后，运行时通过原生 `agent/request` 瀑布控制推理预算。它只读取持久化工作流阶段：首次决策或契约映射使用 `low`，有界 HIVE/提供商回执后的综合使用 `off`，模型主动加载详细技能后恢复为 `high`。准确的已注册适配器会在提示获准前验证建议强度；不支持关闭推理或强制推理的模型保留其原生默认值。用户通过原生会话或模型控件显式选择的强度绝不会被覆盖。该策略不包含提示分类器、用户规则、提供商规则或应用名称分支。

## 开发说明

源包负责身份支持的组合和本地连接路由。不要把凭据和租户权限放入浏览器代码、工具参数或模型可见结果。

## 模型体验

### 渐进式 HIVE 能力访问

#### 模型看到的内容

模型最初看不到技能目录或预先加载的组织档案。它可以根据系统契约和最近完成的对话直接回答、提出一个简洁的澄清问题、直接调用有界的已注册工具，或通过 `hivemind_capabilities` 请求精简目录。已认证档案上下文仅通过 `hivemind_meta context` 加载。当前轮次的工具结果可用于综合，并由历史投影从后续轮次中移除。

#### Token 影响

初始请求只承担直接工具 schema 的成本，不包含技能目录或组织档案。详细执行手册仅在当前轮次增加一次能力请求回执和一次原生目录。

#### KV Cache 影响

稳定的系统契约和已注册工具列表可以复用。档案证据、目录内容和任务回执只在请求时出现在该前缀之后。

## 已知限制和延后工作

- 该集成为只读能力：员工执行和连接应用操作仍是独立能力。
- 浏览器身份验证使用本地 ICARUS 配置，而不是托管式多租户凭据服务。
- 超出首批前五条结果的渐进式召回分页尚未实现。
