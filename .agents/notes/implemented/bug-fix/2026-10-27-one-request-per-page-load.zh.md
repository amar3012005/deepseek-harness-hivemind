# Agent Note：页面加载时每个独立读取只运行一次

状态：已实现

## 问题

Brain 页面加载时，同一批目录在几秒内被重复读取：新会话芯片、页眉标签和设置分区各调用一次 `agentPresets.list`；首次 `connection/reset` 又重复读取 `commands/list` 与 `messageFeedback/list`；选中会话和打开其目录菜单各读取一次 `subagents/list`；每个浏览器账户缓存各自探测一次 bootstrap 身份。

## 决定

- `ui-agent-preset`：`readRoster` 在每个上下文内共享 4 秒内的同一结果；设置修改、新建预设、分区写入和非初始重连则重新读取。
- `ui-commands` 与 `ui-message-feedback` 遵循 `connection/reset` 的 `initial` 标志：正在进行或已应答的读取保留其结果。
- `SessionManager.select`、`selectSubagent` 与目录菜单打开，仅在目录结果超过 4 秒时才读取；成员帧和重连始终读取。
- `createBrowserAccountCache` 每个页面只共享一次 bootstrap 探测。

## 考虑过的替代方案

- 在网关合并所有相同的 Remote 调用。否决：它无法区分读取与状态变更，并会掩盖重复读取的归属方。
- 不按房间事件失效而直接缓存。否决：窗口内的实时事件会显示过期状态。

## 影响

- 改变状态的请求、实时事件和真正的重连仍然读取最新数据；只有挂载时的读取最多滞后 4 秒。
- Runtime 谱系中同一改动里仅属于 Runtime 的读取方（`RuntimeTour`、苏醒门、HQ 工作区）在 Brain 中不存在，未移植。
