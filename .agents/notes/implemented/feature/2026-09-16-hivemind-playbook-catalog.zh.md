# Agent Note: 隔离 skill 提供方上的 HIVE-MIND playbook 目录

Status: implemented

[English](2026-09-16-hivemind-playbook-catalog.md) | 中文

## 问题

`hivemind` preset 已经克隆 Standard 并加入已认证的公司插件，但其 skill（技能）提供方是隔离的：`includeDefaultRoots: false`，因此问候语不必为用户的整份开发目录付费。隔离却没有替代根目录，意味着目录是空的。唯一落在磁盘上的公司 skill `composio-connected-workflows` 就在 composition 旁边，对该 preset 不可见。`hivemind-chat` 已经把 `customSkillDirs` 指向 `presets/hivemind/skills/`，因此 chat preset 与完整公司大脑 preset 在“是否存在目录”上不一致。

公司房间在把 Room 做成 Session（会话） webhook 或启用 Agent Teams 做真实工作之前，仍然需要 HyperAgent `execution_profiles` playbook（执行手册）以及 output-contract 规则（视觉选择加入、永不扣留文本草稿）。第二套房间类型分类会与 HIVEMIND 已经运行的 profile 漂移。

## 决策

精选的公司目录位于 `packages/preset/agent-presets/presets/hivemind/skills/<name>/SKILL.md`。两个 HIVE preset 都发现这一个目录。`includeDefaultRoots` 保持 `false`。`watch` 保持 `false`。原生 `skill` 工具保持挂载。`hivemind_capabilities` 仍然在模型请求 playbook 之前扣留目录。Lead persona 仍是公司大脑，并且不设置 `complete: true`。

### 目录位置

发现规则是一层 `<root>/<name>/SKILL.md`。`hivemind` 的 skill-filesystem 行使用带 `baseUrl` 的 `customSkillDirs`，因此无论 shipped preset 安装在何处，根目录都能解析：

```js
process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))
```

`hivemind-chat` 保持兄弟路径 `../hivemind/skills/`。没有第二棵 skill 树。

### Playbook 映射

Playbook skill 与现有 `EXECUTION_PROFILES` 一一对应，但 `general.answer.v1` 除外：它是默认的直接回答 profile，没有 skill。

| Skill | Profile id | Required artifacts |
|---|---|---|
| `playbook-research` | `research.decision.v1` | `source_ledger`, `decision_artifact` |
| `playbook-campaign` | `campaign.contract.v1` | `campaign_contract` |
| `playbook-outreach` | `outreach.prepare.v1` | sourced leads and verified drafts |
| `playbook-marketing` | `marketing.artifact.v1` | `marketing_artifact` |
| `playbook-seo` | `seo.audit.v1` | `seo_evidence` |
| `playbook-branding` | `branding.artifact.v1` | `branding_artifact` |
| `playbook-fundraising` | `fundraising.artifact.v1` | `fundraising_artifact` |
| `playbook-product` | `product.artifact.v1` | `product_artifact` |
| `playbook-design` | `design.artifact.v1` | `design_artifact` |
| `playbook-finance` | `legal_finance.review.v1` | `review_artifact` |

每个 playbook 写明其 profile id、room kind、effect（`prepare_only`），以及散文不得替代的工作区文件。

### 共享 skill

跨切目录条目是 `output-contract`（五条规则：视觉选择加入、证据独立于视觉、仅对必需的视觉产物运行 render gate、永不扣留文本草稿、profile-none 保持文本）、`visual-artifact`（仅限显式视觉请求）、`research-web`（原生 `web_search` / `web_fetch`，与公司记忆分开），以及已有的 `composio-connected-workflows`。多源公司召回仍是运行时 skill `hivemind-company-brain`；本目录不把它再复制为 `hive-recall` / `hive-portrait` / `hive-evidence`。

### 接线

`packages/preset/agent-presets/presets/hivemind/agent.cordis.yml` 在现有 `skill-filesystem` 行（`providerName: hivemind-filesystem`）上加入 `customSkillDirs`。不添加 Agent Teams 插件、webhook 产品桥，也不添加 Docker MCP Gateway 行。

### 范围之外

本次变更不创建 HyperRoom、Session webhook、teammate roster、Composio slug 爆炸，也不创建生产 runner 镜像。线上 `hivemind-harness-runner` 与 employees-service 保持不动。公司记忆留在 HIVE Core。

## 备选方案

- **用 `bundledSkillDir` 代替 `customSkillDirs`** — 否决：隔离提供方本来就会丢掉环境 bundled 根目录，而 shipped 的 `cordis` / `hivemind-chat` preset 已经使用 `customSkillDirs` 加 `baseUrl`。rank 300 的 custom 才是匹配的发现桶。
- **第二套房间类型或 Grok-Bot jobs 分类** — 否决：playbook 必须与 `execution_profiles.py` 保持 1:1，否则 Director 与 Cordis 房间会在必需产物上不一致。
- **把 marketing 拆成 copy 与 artifact 两个 skill** — 否决：注册表只有 `marketing.artifact.v1`。
- **为 recall、portrait 和 evidence 再做文件系统 skill** — 否决：`hivemind-company-brain` 已由 `hivemind-runtime` 注册。
- **在 Lead persona 上设置 `complete: true`** — 否决：该标志会抑制 Team 与 skill 组装。
- **扫描默认的项目/用户 skill 根目录** — 否决：那正是隔离提供方要避免的问候语 token 成本。
- **从 Cordis 包重建流水线** — 否决：生产租户留在 HIVEMIND；本克隆升级保留的 `hivemind` preset。

## 后果

`hivemind_capabilities` 现在揭示精选目录（十份 playbook 加四份共享 skill，以及运行时的公司大脑 skill），而不再是空列表。两个 HIVE preset 共享一个目录，因此一次 playbook 编辑会同时进入 chat 与完整公司大脑 preset。目录 token 成本只在显式能力请求之后支付。后续阶段仍需加入 Room=Session 接线、Agent Teams 和 Enigma canary；那些阶段不得再发明一棵并行的 skill 树。

## 测试

`packages/preset/agent-presets/tests/shipped-root.spec.ts` 断言隔离提供方配置、两个 HIVE preset 上的 `customSkillDirs` 接线、精确的 skill 目录清单、playbook 到 profile id 的出现，以及五条 output-contract 规则。不新增 recorded-session snapshot：目录在 `hivemind_capabilities` 之前被扣留，且本仓库没有现成的 hivemind snapshot 所有者。无头 keyed E2E 仍需要实验室专用的 `DSH_SANDBOX_MODEL_KEY`。
