/** Localized copy for the HIVE-MIND connection control. */
export type HivemindConnectKey =
  | 'connect' | 'connected' | 'connecting' | 'unavailable' | 'disconnect' | 'history' | 'history.empty'
  | 'session.new' | 'session.recent' | 'session.running' | 'composio.app' | 'composio.checking'
  | 'composio.connectionRequired' | 'composio.approvalRequired' | 'composio.failed' | 'composio.completed'
  | 'composio.connect' | 'composio.connectDetail' | 'composio.authorize' | 'composio.draftDetail'

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
  'composio.failed': 'Connected-app task failed', 'composio.completed': 'Connected-app task completed',
  'composio.connect': 'Connect {app}', 'composio.connectDetail': 'Authorize in a new tab. HIVE-MIND will verify the connection before continuing.',
  'composio.authorize': 'Authorize', 'composio.draftDetail': 'Review the editable draft before approving. Nothing has been sent.',
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
  'composio.failed': '连接应用任务失败', 'composio.completed': '连接应用任务已完成',
  'composio.connect': '连接 {app}', 'composio.connectDetail': '请在新标签页中授权。HIVE-MIND 会在继续前验证连接。',
  'composio.authorize': '授权', 'composio.draftDetail': '批准前请检查可编辑草稿。尚未发送任何内容。',
}
