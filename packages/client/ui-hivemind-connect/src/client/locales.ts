/** Localized copy for the HIVE-MIND connection control. */
export type HivemindConnectKey =
  | 'activity.search' | 'activity.website' | 'activity.capture' | 'activity.memory' | 'activity.draft' | 'activity.team'
  | 'connect' | 'connected' | 'connecting' | 'unavailable' | 'disconnect' | 'history' | 'history.empty'
  | 'session.new' | 'session.recent' | 'session.running' | 'composio.app' | 'composio.checking'
  | 'composio.connectionRequired' | 'composio.connectionPending' | 'composio.approvalRequired' | 'composio.failed' | 'composio.completed' | 'composio.cancelled'
  | 'composio.connect' | 'composio.connectDetail' | 'composio.authorize' | 'composio.draftDetail' | 'composio.inspect'
  | 'composio.connectionPrompt' | 'composio.connectionActionDetail'
  | 'composio.inputRequired' | 'composio.verifying'
  | 'composio.continue'
  | 'composio.dismiss'
  | 'composio.connected' | 'composio.connectionVerified'
  | 'employee.joined' | 'employee.ownerLocked' | 'employee.initial' | 'employee.auto' | 'employee.autoDetail' | 'employee.label' | 'employee.loading' | 'employee.unavailable'
  | 'employee.environment' | 'employee.hide' | 'employee.working' | 'employee.ready' | 'employee.panel' | 'employee.toggle'
  | 'employee.settings' | 'employee.connectApps' | 'employee.creditsUsed'
  | 'workbench.filter' | 'workbench.all' | 'workbench.grid' | 'workbench.stack' | 'workbench.lastViewed'
  | 'workbench.preview' | 'workbench.artifacts' | 'workbench.computer' | 'workbench.sources'
  | 'website.select' | 'website.open' | 'website.title' | 'website.embedding' | 'website.failed' | 'website.preview'
  | 'workbench.textUnavailable' | 'workbench.loading' | 'workbench.copy' | 'workbench.copied' | 'workbench.footnotes'
  | 'workbench.emptyPreview' | 'workbench.emptyArtifacts' | 'workbench.emptyComputer' | 'workbench.emptySources' | 'workbench.pdfUnavailable' | 'workbench.browserCapture' | 'workbench.open' | 'workbench.download' | 'workbench.downloadPdf'

export const en: Record<HivemindConnectKey, string> = {
  'employee.joined': '{name} joined our team',
  'activity.search': 'Searching public sources…', 'activity.website': 'Reading website…', 'activity.capture': 'Capturing website…', 'activity.memory': 'Working with memory…', 'activity.draft': 'Drafting an artifact…', 'activity.team': 'Coordinating with the team…',
  'workbench.filter': 'Filter', 'workbench.all': 'All files', 'workbench.grid': 'Grid view', 'workbench.stack': 'Stack view', 'workbench.lastViewed': 'Last viewed',
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
  'employee.initial': 'H', 'employee.auto': 'HyperAgents', 'employee.ownerLocked': 'This employee owns the session. Start a new session to choose another.', 'employee.autoDetail': 'Persistent HyperAgents Team Lead',
  'employee.label': 'Choose employee', 'employee.loading': 'Loading employees…',
  'employee.unavailable': 'Employee directory unavailable. Selection unchanged.',
  'employee.environment': 'Environment', 'employee.hide': 'Hide', 'employee.working': 'Working on this task',
  'employee.ready': 'Ready for a task', 'employee.panel': 'Agent', 'employee.toggle': 'Toggle right panel',
  'employee.settings': 'Environment settings', 'employee.connectApps': 'Connect apps', 'employee.creditsUsed': 'Credits used',
  'workbench.preview': 'Preview', 'workbench.artifacts': 'Artifacts', 'workbench.computer': 'Computer', 'workbench.sources': 'Sources',
  'workbench.emptyPreview': 'Generated work appears here when ready.', 'workbench.emptyArtifacts': 'No artifacts yet.',
  'website.select': 'Source website',
  'website.open': 'Open source',
  'website.title': 'Source website',
  'website.preview': 'View source',
  'website.embedding': 'Some websites block embedded viewing. If the page is blank or unavailable, open the source directly.',
  'website.failed': 'This website could not be embedded. Open the source directly.',
  'workbench.textUnavailable': 'Document preview could not be loaded. You can still download it.',
  'workbench.loading': 'Loading document…',
  'workbench.copy': 'Copy',
  'workbench.copied': 'Copied',
  'workbench.footnotes': 'Footnotes',
  'workbench.pdfUnavailable': 'PDF preview could not be loaded. You can still download the PDF.',
  'workbench.emptyComputer': 'Browser captures appear here when ready.', 'workbench.emptySources': 'Research sources appear here when ready.',
  'workbench.browserCapture': 'Browser capture · HTTP',
  'workbench.open': 'Open artifact',
  'workbench.download': 'Download',
  'workbench.downloadPdf': 'Download PDF',
}

export const zh: Record<HivemindConnectKey, string> = {
  'employee.joined': '{name} 已加入我们的团队',
  'activity.search': '正在搜索公开来源…', 'activity.website': '正在阅读网站…', 'activity.capture': '正在截取网站…', 'activity.memory': '正在处理记忆…', 'activity.draft': '正在编写成果…', 'activity.team': '正在与团队协调…',
  'workbench.filter': '筛选', 'workbench.all': '全部文件', 'workbench.grid': '网格视图', 'workbench.stack': '堆叠视图', 'workbench.lastViewed': '最近查看',
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
  'employee.initial': 'H', 'employee.auto': 'HyperAgents', 'employee.ownerLocked': '此员工负责本会话。请新建会话以选择其他员工。', 'employee.autoDetail': '持久 HyperAgents 团队负责人',
  'employee.label': '选择员工', 'employee.loading': '正在加载员工…',
  'employee.unavailable': '员工目录不可用，选择未更改。',
  'employee.environment': '工作环境', 'employee.hide': '隐藏', 'employee.working': '正在执行任务',
  'employee.ready': '等待任务', 'employee.panel': '员工', 'employee.toggle': '切换右侧面板',
  'employee.settings': '工作环境设置', 'employee.connectApps': '连接应用', 'employee.creditsUsed': '已使用额度',
  'workbench.preview': '预览', 'workbench.artifacts': '成果', 'workbench.computer': '电脑', 'workbench.sources': '来源',
  'workbench.emptyPreview': '生成的成果就绪后将在此显示。', 'workbench.emptyArtifacts': '暂无成果。',
  'website.select': '来源网站',
  'website.open': '打开来源',
  'website.title': '来源网站',
  'website.preview': '查看来源',
  'website.embedding': '部分网站不允许嵌入显示。如果页面空白或不可用，请直接打开来源。',
  'website.failed': '无法嵌入此网站。请直接打开来源。',
  'workbench.textUnavailable': '无法加载文档预览。你仍可下载文档。',
  'workbench.loading': '正在加载文档…',
  'workbench.copy': '复制',
  'workbench.copied': '已复制',
  'workbench.footnotes': '脚注',
  'workbench.pdfUnavailable': '无法加载 PDF 预览。你仍可下载 PDF。',
  'workbench.emptyComputer': '浏览器截图就绪后将在此显示。', 'workbench.emptySources': '研究来源就绪后将在此显示。',
  'workbench.browserCapture': '浏览器截图 · HTTP',
  'workbench.open': '打开成果',
  'workbench.download': '下载',
  'workbench.downloadPdf': '下载 PDF',
}
