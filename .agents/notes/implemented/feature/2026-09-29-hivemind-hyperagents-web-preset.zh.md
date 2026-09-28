# Agent Note: 已认证的 HIVE Web 运行器提供公司工作预设

Status: implemented

[English](2026-09-29-hivemind-hyperagents-web-preset.md) | 中文

## Problem

HIVE Web 运行器此前只允许 `hivemind-chat`。现有的 `hyperagents` 预设包含主机编程及本地工作区工具，直接在租户限定的嵌入式运行器中放行会突破托管工作边界。

## Decision

运行器允许 `hivemind-chat` 和 `hivemind-hyperagents`，并保持聊天模式为默认。新预设包含聊天模式的 Cordis 组合，包括隔离的 HIVE 身份、限定范围的服务权限、记忆、技能及受治理的连接应用。它只替换角色提示并加入原生待办事项。父会话内联完成公司工作；员工档案是已认证的工作视角，默认不创建子代理。原生预设选择器无需前端分叉即可显示两种模式。现有会话保留其所选预设。

## Alternatives considered

**直接允许现有的 `hyperagents` 预设。** 未采用，因为完整编程组合会在托管公司会话中暴露 shell、文件系统和本地工作区能力。

**分叉代理循环或前端。** 未采用，因为原生预设注册表与选择器已经提供按会话组合及模式选择。

## Consequences

两种模式共享认证工具及审批契约。HyperAgents 改变工作指引并提供原生待办事项，但此第一阶段不新增持久化 WorkRun 或独立员工执行。每次运行器发布后，必须通过镜像级配置检查和已认证会话测试验证两种模式。
