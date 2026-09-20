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
  | 'rooms.file.pdf' | 'rooms.file.ppt' | 'rooms.file.generic'
  | 'rooms.company.title' | 'rooms.company.meta' | 'rooms.company.detail'
  | 'rooms.mission.title' | 'rooms.mission.meta' | 'rooms.mission.detail'
  | 'rooms.research.title' | 'rooms.research.meta' | 'rooms.research.detail'
  | 'rooms.compliance.title' | 'rooms.compliance.meta' | 'rooms.compliance.detail'
  | 'rooms.funnel.title' | 'rooms.funnel.meta' | 'rooms.funnel.detail'
  | 'rooms.journey.title' | 'rooms.journey.meta' | 'rooms.journey.detail'
  | 'rooms.report.title' | 'rooms.report.meta' | 'rooms.report.detail'
  | 'rooms.deck.title' | 'rooms.deck.meta' | 'rooms.deck.detail'
  | 'rooms.assets.title' | 'rooms.assets.meta' | 'rooms.assets.detail'
  | 'rooms.roadmap.title' | 'rooms.roadmap.meta' | 'rooms.roadmap.detail'

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
  'rooms.file.pdf': 'PDF', 'rooms.file.ppt': 'PPT', 'rooms.file.generic': '—',
  'rooms.company.title': 'Company Profile', 'rooms.company.meta': '12 items', 'rooms.company.detail': 'Company info, branding, team',
  'rooms.mission.title': 'Mission', 'rooms.mission.meta': '8 items', 'rooms.mission.detail': 'Strategy, vision, positioning',
  'rooms.research.title': 'Market Research', 'rooms.research.meta': '14 items', 'rooms.research.detail': 'Reports, analysis, data',
  'rooms.compliance.title': 'GDPR Compliance', 'rooms.compliance.meta': '9 items', 'rooms.compliance.detail': 'Legal, compliance, policies',
  'rooms.funnel.title': 'Lead Funnel', 'rooms.funnel.meta': '11 items', 'rooms.funnel.detail': 'Campaigns, targeting',
  'rooms.journey.title': 'User Journey', 'rooms.journey.meta': '8 items', 'rooms.journey.detail': 'Onboarding, UX flows',
  'rooms.report.title': 'Market_Research.pdf', 'rooms.report.meta': '2.4 MB · Updated 2 days ago', 'rooms.report.detail': 'EU market analysis',
  'rooms.deck.title': 'Investor_Deck_v1.pptx', 'rooms.deck.meta': '12.8 MB · Updated 3 days ago', 'rooms.deck.detail': 'Fundraising deck',
  'rooms.assets.title': 'HQ Assets', 'rooms.assets.meta': '19 items', 'rooms.assets.detail': 'Logos, media, templates',
  'rooms.roadmap.title': 'Roadmap.md', 'rooms.roadmap.meta': '2 KB · Updated today', 'rooms.roadmap.detail': 'Next steps and milestones',
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
  'rooms.file.pdf': 'PDF', 'rooms.file.ppt': 'PPT', 'rooms.file.generic': '—',
  'rooms.company.title': '公司资料', 'rooms.company.meta': '12 项', 'rooms.company.detail': '公司信息、品牌与团队',
  'rooms.mission.title': '使命', 'rooms.mission.meta': '8 项', 'rooms.mission.detail': '战略、愿景与定位',
  'rooms.research.title': '市场研究', 'rooms.research.meta': '14 项', 'rooms.research.detail': '报告、分析与数据',
  'rooms.compliance.title': 'GDPR 合规', 'rooms.compliance.meta': '9 项', 'rooms.compliance.detail': '法律、合规与政策',
  'rooms.funnel.title': '线索漏斗', 'rooms.funnel.meta': '11 项', 'rooms.funnel.detail': '活动与目标客户',
  'rooms.journey.title': '用户旅程', 'rooms.journey.meta': '8 项', 'rooms.journey.detail': '入职与体验流程',
  'rooms.report.title': '市场研究.pdf', 'rooms.report.meta': '2.4 MB · 2 天前更新', 'rooms.report.detail': '欧盟市场分析',
  'rooms.deck.title': '投资者演示.pptx', 'rooms.deck.meta': '12.8 MB · 3 天前更新', 'rooms.deck.detail': '融资演示文稿',
  'rooms.assets.title': '总部资源', 'rooms.assets.meta': '19 项', 'rooms.assets.detail': '标志、媒体与模板',
  'rooms.roadmap.title': '路线图.md', 'rooms.roadmap.meta': '2 KB · 今日更新', 'rooms.roadmap.detail': '下一步与里程碑',
}
