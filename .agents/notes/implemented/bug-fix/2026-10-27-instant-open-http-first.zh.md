# Agent Note：房间数据先走 HTTP，不等推送流

状态：已实现

## 问题

2026 年 10 月 27 日的生产页面加载出现约 20 秒没有任何 API 请求的空档，随后出现成批的重复请求。Session 列表只在 `handleConnected` 中拉取，而它在 `connection/reset` 之后才运行，也就是事件流的 ready 帧之后。构造时已加载的目录（模型目录、智能体名册、日程、模型页）又被第一次 `connection/reset` 重置并再次读取。生成失败或变慢时，`streams.reconnect()` 会关闭仍然健康或正在连接的 WebSocket，并让所有逻辑流重新打开。每个挂载的组件都会重复读取 boot 和外观。房间状态读取 `connection.state`，而房间自己的事件流已经在送事件时它仍是 `connecting`。

## 决定

- `session-controller` 在 apply 时就开始拉取列表。首次 `handleConnected` 保留进行中的拉取和已读取的子智能体目录。
- `connection/reset(initial)` 标记首个连接代。模型目录、名册、模型页、日程目录保留加载中或已应答的读取；失败的读取会重新加载。
- `onReconnectRequested(replacePhysical)`：自动重试保留已打开或正在连接的 WebSocket。手动重连、浏览器网络变化和超过硬性就绪期限才替换它。
- boot 探测、Runtime 外观读取和模型连接状态分别按 30 秒、10 秒、10 秒窗口共享。外观保存成功后清除窗口。
- Session 自身事件流上的 `turn/start` 或 `turn/end` 会更新其运行位。房间的 `stale` 和 Runtime 动效把已打开的房间流视为在线。
- 「Loading history」提示仅在没有任何已渲染条目时显示，因此缓存的尾部不会被遮住。
- `prefetchHistory` 把最多 12 个已列出房间的最新一页写入本地历史副本（同时 2 个请求）；指针或焦点移到侧栏行时该房间优先。

## 考虑过的替代方案

- 调大 `generationReadyTimeoutMs`。否决：观察到的失败不是期限，更长的期限只会推迟真正卡死时的恢复。
- 把任何 mux 帧都当作 `connected`。否决：`connected` 承诺 Remote 事件已经接上。

## 后果

- 慢速 Host 不再重启所有流。卡死的载体仍会在就绪期限后被替换。
- 把 `connection/reset` 监听器固定为 `() => void` 的外壳仍可工作；该参数可选。
