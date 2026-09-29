# Agent Note: HyperAgents 无浏览器渲染 Markdown PDF

Status: implemented

[English](2026-09-29-direct-markdown-pdf-preview.md) | 中文

## 问题

生产 runner 的 PDF 工具依赖 Playwright Chromium，而已部署的运行时镜像没有该浏览器。Preview 选项卡只显示第一页 PNG，因此用户无法在面板中阅读多页报告。

## 决策

`hivemind_artifact_render` 接收 Markdown，并通过 `@speajus/markdown-to-pdf` 和 PDFKit 直接生成文档。其 PDFKit 依赖固定为 npm 版本 `0.17.2`；renderer 禁用 emoji 字体，并阻止读取图片文件或获取网络图片。PDF.js 将第一页栅格化为持久缩略图，事件继续保存 PDF 和预览附件引用。

HyperAgents Preview 选项卡通过经过 session 授权的附件 Remote 获取 PDF，并在可滚动的浏览器 PDF 框架中嵌入文档，同时提供“下载 PDF”操作。其他 HTML 和 Office 成果路径保留现有 renderer。

对话中的 PDF 成果卡片也提供**在预览中打开**操作，可打开该 session 的 Preview 选项卡；PDF 本身从该 session 的最新成果中读取。

## 考虑过的替代方案

**将 Markdown 转成 HTML，再通过 Playwright 打印。** 不采用，因为已部署的 runner 没有浏览器运行时，而且无需启动浏览器即可从 Markdown 生成 PDF。

**安装 Markdown 包的 GitHub PDFKit fork 及其 postinstall。** 不采用，因为仓库会阻止非标准的传递依赖。npm PDFKit 版本支持本功能使用的报告内容；emoji 彩色字体已禁用，因此不需要 fork 的补丁。

**只预览第一页图片。** 不采用，因为用户无法在 Preview 面板中检查完整报告。

## 影响

PDFKit 对 PDF 文本、标题、列表、表格和链接进行分页，并根据 HIVE 设计配置选择排版。Markdown 图片引用会显示为占位符；renderer 不会读取本地路径或获取 URL。iframe 使用浏览器原生 PDF 查看器，现有 PNG 仍作为聊天记录中快速显示的缩略图。
