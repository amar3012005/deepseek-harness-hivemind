# Agent Note：工具结果媒体按原生内容契约渲染

状态：已实现

[English](2026-09-09-inline-tool-result-media.md) | 中文

## 问题

MCP bridge 已把截图字节作为持久图像附件引用写入 `tool/result`。Chat 可以加载这些引用，但只有 keyed `read_image` 工具视图会渲染图库。因此，浏览器截图和未来图像生成工具只在可展开的通用回执中暴露附件，而不会直接内联显示媒体。

## 决策

工具调用树从每个成功结果的原生内容 block 中推导有序图像引用，并通过 Cordis 子槽位 `tool.call.inline-images` 在未改动的工具行下方渲染。附件呈现插件用现有的 Session 授权图库与灯箱填充该槽位。

路由只依据持久内容形状，不匹配 Playwright、MCP 或图像生成器工具名称。任何格式错误的图像 block 都会拒绝整个内联图库，失败的工具结果也不会渲染内联媒体；其权威回执仍保持可见。

专用 `read_image` 展开卡片保留现有的 `tool.call.images` 图库。内联呈现只增加 transcript 直观视图，不替换工具生命周期、结果、metadata、检查入口或模型可见内容。

## 考虑过的替代方案

- **逐个注册媒体工具名称**——拒绝，因为 provider 与工具目录独立于 Client renderer 演进。
- **把远程图像 URL 复制进 React 状态**——拒绝，因为 UI 状态不持久、不具备 replay 授权，也不按租户隔离。
- **改写助手最终回答以包含图像**——拒绝，因为这会伪造模型输出并重复权威工具结果。

## 后果

- MCP 截图及未来返回原生持久图像 block 的工具会自动内联渲染。
- 现有附件存储、Session 授权、URL 生命周期、图库布局和灯箱仍是唯一字节加载路径。
- 纯文本结果、失败和格式错误的旧记录继续使用现有工具 UI。

## 验证

- `packages/client/ui-tool/tests/tool-call-tree.client.spec.tsx` 覆盖任意工具的内联投影，以及失败或格式错误结果的拒绝。
- `packages/client/ui-attachment/tests/plugin.client.spec.ts` 覆盖新 Cordis 槽位注册项的注册与卸载。
- 现有 image-card 与 attachment 测试继续保证专用渲染、replay 加载与灯箱行为。
