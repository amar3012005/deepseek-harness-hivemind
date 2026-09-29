/** Localized copy for the HIVE-MIND connection control. */
export type HivemindConnectKey =
  | 'connect' | 'connected' | 'connecting' | 'unavailable' | 'disconnect' | 'history' | 'history.empty'
  | 'session.new' | 'session.recent' | 'session.running' | 'composio.app' | 'composio.checking'
  | 'composio.connectionRequired' | 'composio.connectionPending' | 'composio.approvalRequired' | 'composio.failed' | 'composio.completed' | 'composio.cancelled'
  | 'composio.connect' | 'composio.connectDetail' | 'composio.authorize' | 'composio.draftDetail' | 'composio.inspect'
  | 'composio.connectionPrompt' | 'composio.connectionActionDetail'
  | 'composio.inputRequired' | 'composio.verifying'
  | 'composio.continue'
  | 'composio.dismiss'
  | 'composio.connected' | 'composio.connectionVerified'
  | 'employee.initial' | 'employee.auto' | 'employee.autoDetail' | 'employee.label' | 'employee.loading' | 'employee.unavailable'
  | 'employee.environment' | 'employee.working' | 'employee.ready' | 'employee.panel' | 'employee.toggle'
  | 'workbench.preview' | 'workbench.artifacts' | 'workbench.computer' | 'workbench.sources'
  | 'workbench.emptyPreview' | 'workbench.emptyArtifacts' | 'workbench.emptyComputer' | 'workbench.emptySources' | 'workbench.browserCapture' | 'workbench.open' | 'workbench.download'

export const en: Record<HivemindConnectKey, string> = {
  connect: 'Connect HIVE-MIND',
  connected: 'HIVE-MIND connected',
  connecting: 'Connecting HIVE-MIND…',
  unavailable: 'HIVE-MIND unavailable',
  disconnect: 'Disconnect HIVE-MIND',
  history: 'History',
  'history.empty': 'No previous conversations',
  'session.new': 'New session',
  'session.recent': 'Recent',
  'session.running': 'Running',
  'composio.app': 'connected app', 'composio.checking': 'Checking connected apps…',
  'composio.connectionRequired': 'Connection required', 'composio.approvalRequired': 'Approval required',
  'composio.connectionPending': 'Waiting for connection',
  'composio.failed': 'Connected-app task failed', 'composio.completed': 'Connected-app task completed',
  'composio.cancelled': 'Connection request cancelled',
  'composio.connect': 'Connect {app}', 'composio.connectDetail': 'Authorize in a new tab. HIVE-MIND will verify the connection before continuing.',
  'composio.authorize': 'Authorize', 'composio.draftDetail': 'Review the editable draft before approving. Nothing has been sent.',
  'composio.inspect': 'Inspect connected-app tool input and output',
  'composio.connectionPrompt': 'Connect {app} to continue, then return here.',
  'composio.connectionActionDetail': 'Authorize in a new tab, then continue this request.',
  'composio.inputRequired': 'I need your input to continue',
  'composio.verifying': 'Verifying connection…',
  'composio.continue': "I've connected {app} — continue",
  'composio.dismiss': 'Dismiss and stop this turn',
  'composio.connected': '{app} connected',
  'composio.connectionVerified': 'Connection verified. Continuing this request.',
  'employee.initial': 'H', 'employee.auto': 'HyperAgents', 'employee.autoDetail': 'Let Harness choose an employee',
  'employee.label': 'Choose employee', 'employee.loading': 'Loading employees…',
  'employee.unavailable': 'Employee directory unavailable. Selection unchanged.',
  'employee.environment': 'Environment', 'employee.working': 'Working on this task',
  'employee.ready': 'Ready for a task', 'employee.panel': 'Agent', 'employee.toggle': 'Swap Preview and Agent',
  'workbench.preview': 'Preview', 'workbench.artifacts': 'Artifacts', 'workbench.computer': 'Computer', 'workbench.sources': 'Sources',
  'workbench.emptyPreview': 'Generated work appears here when ready.', 'workbench.emptyArtifacts': 'No artifacts yet.',
  'workbench.emptyComputer': 'Browser captures appear here when ready.', 'workbench.emptySources': 'Research sources appear here when ready.',
  'workbench.browserCapture': 'Browser capture · HTTP',
  'workbench.open': 'Open artifact',
  'workbench.download': 'Download',
}

export const zh: Record<HivemindConnectKey, string> = {
  connect: '连接 HIVE-MIND',
  connected: 'HIVE-MIND 已连接',
  connecting: '正在连接 HIVE-MIND…',
  unavailable: 'HIVE-MIND 不可用',
  disconnect: '断开 HIVE-MIND',
  history: '历史记录',
  'history.empty': '暂无历史对话',
  'session.new': '新建会话',
  'session.recent': '最近',
  'session.running': '运行中',
  'composio.app': '已连接应用', 'composio.checking': '正在检查已连接应用…',
  'composio.connectionRequired': '需要连接', 'composio.approvalRequired': '需要批准',
  'composio.connectionPending': '等待连接',
  'composio.failed': '连接应用任务失败', 'composio.completed': '连接应用任务已完成',
  'composio.cancelled': '连接请求已取消',
  'composio.connect': '连接 {app}', 'composio.connectDetail': '请在新标签页中授权。HIVE-MIND 会在继续前验证连接。',
  'composio.authorize': '授权', 'composio.draftDetail': '批准前请检查可编辑草稿。尚未发送任何内容。',
  'composio.inspect': '查看连接应用工具的输入和输出',
  'composio.connectionPrompt': '连接 {app} 后返回此处继续。',
  'composio.connectionActionDetail': '请在新标签页中授权，然后继续此请求。',
  'composio.inputRequired': '需要你的输入才能继续',
  'composio.verifying': '正在验证连接…',
  'composio.continue': '我已连接 {app} — 继续',
  'composio.dismiss': '关闭并停止本轮',
  'composio.connected': '{app} 已连接',
  'composio.connectionVerified': '连接已验证。正在继续此请求。',
  'employee.initial': 'H', 'employee.auto': 'HyperAgents', 'employee.autoDetail': '让 Harness 选择员工',
  'employee.label': '选择员工', 'employee.loading': '正在加载员工…',
  'employee.unavailable': '员工目录不可用，选择未更改。',
  'employee.environment': '工作环境', 'employee.working': '正在执行任务',
  'employee.ready': '等待任务', 'employee.panel': '员工', 'employee.toggle': '切换预览和员工',
  'workbench.preview': '预览', 'workbench.artifacts': '成果', 'workbench.computer': '电脑', 'workbench.sources': '来源',
  'workbench.emptyPreview': '生成的成果就绪后将在此显示。', 'workbench.emptyArtifacts': '暂无成果。',
  'workbench.emptyComputer': '浏览器截图就绪后将在此显示。', 'workbench.emptySources': '研究来源就绪后将在此显示。',
  'workbench.browserCapture': '浏览器截图 · HTTP',
  'workbench.open': '打开成果',
  'workbench.download': '下载',
}
