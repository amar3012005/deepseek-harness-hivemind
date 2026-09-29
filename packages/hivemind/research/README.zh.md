# HIVE-MIND 治理式研究

[English](README.md) | 中文

本包为 HyperAgents 提供与供应商无关的治理式研究能力。`hivemind_research_answer` 是处理当前多源研究问题的常规任务工具：它拥有一个有界证据任务，并发执行独立问题，并返回一个供父代理综合的、可引用回执。`hivemind_research_request` 处理一个聚焦或存在依赖关系的调查；`hivemind_research_gather` 保留给已经划分独立目标的运行计划。

聚合工具受 `maxGatherObjectives`、`maxGatherSources` 以及现有的单目标结果数和摘录长度限制约束。若一个通道失败而其他通道获得证据，工具会返回部分回执。任务工具会记录 `hivemind/research-workflow-started` 和一个终态 `hivemind/research-workflow-terminal` 事件；同一用户轮次中的已完成任务不能被重新打开。新的用户轮次可以明确请求刷新证据。它不会创建 LLM 子代理、修改原生代理循环或隐藏供应商故障。未完成的远程工作仍由原生作业和持久研究回执管理。预设可设置 `exposeAdvancedTools: false`，仅向模型公开 `hivemind_research_answer`；内部有界聚合仍由该稳定任务工具使用。`injectTerminalReceipts` 用于终态回执在没有原生工具结果时异步到达的研究。内联终态研究预设可以关闭它，让 Standard 的普通工具结果续行直接综合；HIVE-MIND Code 使用该模式。

## 模型体验

对于当前多源问题，模型调用一次 `hivemind_research_answer`，只添加实质上独立的问题，并从其终态回执综合答案。除非回执记录了明确证据缺口，否则模型不会轮询、创建待办或计划，也不会调用原始网页工具。较低层的聚合、单请求和状态工具仍用于运行计划和真正存在依赖关系的工作。
