---
description: "面向 DeepSeek Harness 的 HIVE-MIND 身份、公司上下文、记忆召回和 HyperAgent 发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hivemind-runtime

[English](README.md) | 中文

## 摘要

`dsh-hivemind-runtime` 将 Harness 代理绑定到 ICARUS 保存的 HIVE-MIND 身份。它验证本地凭据并在服务器端解析用户和组织范围。首轮会加入有界、带版本的认证档案摘要；后续仅在直接询问用户或公司档案时刷新该摘要。HIVE 模式暴露有界的直接工具和一个按需能力目录工具，保留最近完成的用户请求和最终回答，并从后续模型请求中移除旧工具载荷。凭据和租户标识不会进入模型可见的 schema 或结果。

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

运行时组合三个可独立测试的能力：`hivemind-context` 负责等待式提示投影，`hivemind-memory` 负责模型可见工具，`hivemind-employee-directory` 验证准确的组织 HyperAgent 档案。第一步模型请求获得系统契约、有界认证档案摘要、有界的已完成对话，以及当前未完成工作流状态。后续直接询问用户或公司档案时会重新加载摘要，因此服务器端版本变化会在下一次相关轮次出现。已注册的直接工具仍然可用，但原生技能目录暂不提供。需要详细执行手册时，模型调用 `hivemind_capabilities`；下一次原生 Harness 步骤会获得当前目录，模型再加载一个相关技能。该流程不修改原生规划器、工具注册表或代理循环。历史投影在 `historyMaxChars` 内最多保留 `historyTurns` 个完成的用户请求和最终助手回答；推理、工具调用和工具输出保留在仅追加日志中，但不会进入后续模型请求。

`hivemind_meta` 支持 `context`、`entities`、`recall`、`save`、`save_status` 和 `profiles`。召回暴露一个去重后的有界结果列表，保留重要内容和引用元数据，并将每条证据限制在 `recallItemMaxChars` 内。实体结果在上游提供时包含规范名称、别名、类型和关联记忆数量。预期的可选服务故障会返回 `entity_index_unavailable`、`memory_retrieval_timeout`、`profile_context_unavailable` 或 `feature_unavailable`，而不会把不可用读取伪装成权威空结果。任何操作都不接受用户或组织标识。

## 开发说明

源包负责身份支持的组合和本地连接路由。不要把凭据和租户权限放入浏览器代码、工具参数或模型可见结果。

## 模型体验

### 渐进式 HIVE 能力访问

#### 模型看到的内容

模型最初会看到系统契约、有界认证档案摘要、最近完成的对话、未完成工作流状态和网关工具，但看不到技能目录。它可以直接从摘要回答用户或公司档案问题，仅在摘要不足时调用 `hivemind_meta context`，也可以调用其他有界工具或通过 `hivemind_capabilities` 请求精简目录。当前轮次的工具结果可用于综合，并由历史投影从后续轮次中移除。

#### Token 影响

初始请求承担有界档案摘要和直接工具 schema 的成本，但不包含技能目录、完整组织档案或旧工具回执。后续普通轮次不带摘要；后续直接档案问题会刷新摘要。详细执行手册仅在当前轮次增加一次能力请求回执和一次原生目录。

#### KV Cache 影响

稳定的系统契约和已注册工具列表可以复用。档案证据、目录内容和任务回执只在请求时出现在该前缀之后。

## 已知限制和延后工作

- 该集成为只读能力：员工执行和连接应用操作仍是独立能力。
- 浏览器身份验证使用本地 ICARUS 配置，而不是托管式多租户凭据服务。
- 超出首批前五条结果的渐进式召回分页尚未实现。
