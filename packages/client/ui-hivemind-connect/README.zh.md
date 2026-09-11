---
description: "DeepSeek Harness Web 客户端侧栏中的 HIVE-MIND 连接控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hivemind-connect

[English](README.md) | 中文

## 摘要

`dsh-client-ui-hivemind-connect` 在 Harness Web 侧栏的设置项上方渲染紧凑的身份控件。ICARUS 负责 OAuth 状态、回调校验和凭据存储；浏览器客户端不会接收 bearer token。

## 使用此包

在 Web bundle 中挂载客户端插件，并在 Host profile 中挂载 `@deepseek-ai/dsh-hivemind-runtime`：

```yaml
- insert:
    - id: hivemind-connect
      name: '@deepseek-ai/dsh-client-ui-hivemind-connect'
```

运行时提供状态、启动和断开端点。开始连接会调用本地 ICARUS OAuth 流程，并且不接受浏览器提供的身份或回调输入。

## 语义

客户端提供一个 `sidebar.footer.action` 插槽。浏览器重新获得焦点后会刷新连接状态，登录进行中时快速轮询，其余时间按有界间隔检查。已连接状态会显示经过验证的邮箱，以及重新连接和断开控件。

此包还提供键为 `hivemind_connected_task` 的工具视图。其持久化结果会先投影每个有界的 Composio 操作，包括搜索和连接管理，再显示连接、审批、完成或失败卡片。重放从已记录的工具结果生成相同的进度行；浏览器状态不是权威数据源。

## 模型体验

模型看不到此浏览器插件的任何内容。配套运行时在服务器端验证后加入公司上下文和渐进式 HIVE-MIND 工具。此包不会增加提示 token，也不会影响模型 KV 缓存。

## 已知限制和延后工作

- 该控件启动本地安装的 ICARUS，并非托管式多租户身份实现。
- 组织员工发现属于 HIVE-MIND 运行时，而不是此浏览器控件。

## 开发说明

OAuth 回调和凭据读取必须留在 ICARUS 或 Host 运行时中；不要把 token 处理移入浏览器代码。
