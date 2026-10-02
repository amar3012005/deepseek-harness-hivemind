/** Human autonomy controls; does not imply authority over external company actions. */
export const en = { active: 'Autonomy active', paused: 'Autonomy paused', wake: 'Wake up', enable: 'Enable HQ', pause: 'Pause HQ', pending: 'Updating HQ…', refresh: 'Refresh HQ status', unavailable: 'HQ status is unconfirmed. Refresh before retrying.', conflict: 'HQ changed elsewhere. Current status loaded.' }
export type HqKey = keyof typeof en
export const zh: Record<HqKey, string> = { active: '自主运行中', paused: '自主运行已暂停', wake: '唤醒', enable: '启用 HQ', pause: '暂停 HQ', pending: '正在更新 HQ…', refresh: '刷新 HQ 状态', unavailable: 'HQ 状态尚未确认。重试前请刷新。', conflict: 'HQ 已在其他地方更新。已加载当前状态。' }
