/** Localized copy for the HIVE-MIND connection control. */
export type HivemindConnectKey =
  | 'connect' | 'connected' | 'connecting' | 'unavailable' | 'disconnect'

export const en: Record<HivemindConnectKey, string> = {
  connect: 'Connect HIVE-MIND',
  connected: 'HIVE-MIND connected',
  connecting: 'Connecting HIVE-MIND…',
  unavailable: 'HIVE-MIND unavailable',
  disconnect: 'Disconnect HIVE-MIND',
}

export const zh: Record<HivemindConnectKey, string> = {
  connect: '连接 HIVE-MIND',
  connected: 'HIVE-MIND 已连接',
  connecting: '正在连接 HIVE-MIND…',
  unavailable: 'HIVE-MIND 不可用',
  disconnect: '断开 HIVE-MIND',
}
