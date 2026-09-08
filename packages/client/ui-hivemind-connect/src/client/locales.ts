/** Localized copy for the HIVE-MIND connection control. */
export type HivemindConnectKey =
  | 'connect' | 'connected' | 'connecting' | 'unavailable' | 'disconnect' | 'history' | 'history.empty'

export const en: Record<HivemindConnectKey, string> = {
  connect: 'Connect HIVE-MIND',
  connected: 'HIVE-MIND connected',
  connecting: 'Connecting HIVE-MIND…',
  unavailable: 'HIVE-MIND unavailable',
  disconnect: 'Disconnect HIVE-MIND',
  history: 'History',
  'history.empty': 'No previous conversations',
}

export const zh: Record<HivemindConnectKey, string> = {
  connect: '连接 HIVE-MIND',
  connected: 'HIVE-MIND 已连接',
  connecting: '正在连接 HIVE-MIND…',
  unavailable: 'HIVE-MIND 不可用',
  disconnect: '断开 HIVE-MIND',
  history: '历史记录',
  'history.empty': '暂无历史对话',
}
