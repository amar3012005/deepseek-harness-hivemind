/**
 * Browser-only HIVE-MIND connection UI host entry.
 * The runtime owns authentication routes; this package contributes presentation.
 */

import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindConnectUi: HivemindConnectUi }
}

/** Orders client graph composition after this passive renderer is mounted. */
export class HivemindConnectUi extends Service {
  constructor(ctx: Context) { super(ctx, 'hivemindConnectUi') }
}

/** Host plugin body required by the Web client bundle loader. */
export function apply(ctx: Context): void { new HivemindConnectUi(ctx) }
