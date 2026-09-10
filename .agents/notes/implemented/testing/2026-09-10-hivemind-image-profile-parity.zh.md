# Agent Note: HIVE runner 镜像拥有已解析 profile 的一致性

Status: implemented

[English](2026-09-10-hivemind-image-profile-parity.md) | 中文

## 问题

源代码层测试可以通过 TypeScript paths 解析工作区包，即使 runner 镜像缺少 `hivemind-chat` preset 所需的包也是如此。部分浏览器资产层还可能禁用原生渲染包，却没有证明最终镜像保留完整的 Web 组合。

## 决策

`deploy/hivemind-chat/Dockerfile` 是唯一的 HIVE runner 镜像配方。它构建完整工作区图，并在镜像安装目录下实体化每个 `@deepseek-ai` 工作区链接。已弃用的 `Dockerfile.frontend-runtime` 不再把选定客户端产物覆盖到另一个 backend 镜像上。

`deploy/hivemind-chat/verify-image.sh` 在构建后的镜像内运行已编译 CLI 和 preset registry。其 probe 要求 Markdown、表格、代码、数学、推理、工具、轨迹、附件、jobs、subagents 和 replay 所需的原生展示行保持启用。它还从镜像文件系统解析 `hivemind-chat` preset 和 connected-apps 包。

## 考虑过的替代方案

**只测试源代码 profile。** 不采用，因为源代码解析可能隐藏镜像中缺失的依赖。

**只包含前端的 overlay 镜像。** 不采用，因为复制选定构建产物会创建第二个包图，并可能与 server 和 preset resolver 漂移。

**为 HIVE 移除原生浏览器 renderer。** 不采用，因为 HIVE 模式是可逆的组合 overlay，必须保留原生会话展示。

## 影响

Runner 产物比仅客户端镜像更大，但携带一个一致的包图。Profile probe 只验证 profile 与 preset 的安装；认证 session admission、持久化与浏览器传输仍由各自服务负责集成验收。
