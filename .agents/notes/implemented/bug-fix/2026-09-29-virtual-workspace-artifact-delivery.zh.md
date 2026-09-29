# Agent Note: 无会话文件系统的产物交付

Status: implemented

[English](2026-09-29-virtual-workspace-artifact-delivery.md) | 中文

## Problem

HyperAgents 使用虚拟工作区。PDF 生成原本假定会话目录可写，因此在生成收据前失败。右侧栏也尝试通过 HIVE Web 配置中停用的工作区文件服务打开产物。

## Decision

HyperAgents 预设直接将生成文件写入持久附件，不写入会话工作区。PDF 和生成事件保留文件引用及图片预览。Session Remote 只有在对应会话日志中找到相同附件引用后才提供文件。操作卡片和右侧栏通过该 Remote 读取；右侧栏使用浏览器对象 URL 打开 PDF。

其他预设仍保留工作区文件输出。附件读取上限为 64 MiB，并核对流式读取的字节数和已提交的引用。

## Alternatives considered

**让 `/opt/deepseek-harness` 可写。** 放弃，因为容器文件系统不是持久会话存储，也无法修复已停用的工作区文件读取路径。

**为 HyperAgents 启用工作区文件。** 放弃，因为这会扩大原本设计为虚拟工作区的配置的文件系统访问范围。

## Consequences

PDF 渲染与下载不再依赖会话目录。模型得到文件名和持久收据，而不是可编辑的工作区路径。超过 Remote 上限的大型产物以后需要流式附件传输。
