/** Exact decimal money arithmetic; no model-generated code or floating point totals. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Parse an explicitly decimal amount into minor units. */
export function minorUnits(value: string): bigint {
  if (!/^-?\d{1,18}(?:\.\d{1,2})?$/.test(value)) throw new Error('Use decimal amounts with at most two places, without currency symbols or separators')
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  const amount = BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'))
  return negative ? -amount : amount
}

/** Format minor units without rounding or conversion through Number. */
export function decimalAmount(value: bigint): string {
  const absolute = value < 0 ? -value : value
  return `${value < 0 ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

/** Register auditable sums and running balances over explicit source amounts. */
export function registerCalculator(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_calculate',
    description: 'Calculate exact decimal money totals and running balances. Supply one currency and signed amounts in chronological order. This checks arithmetic, not the authenticity of the source figures.',
    parameters: {
      amounts: { type: 'array', required: true, items: { type: 'string' }, description: 'Signed decimal amounts, for example ["120.10", "-20.00"].' },
      opening_balance: { type: 'string', description: 'Starting balance; defaults to 0.00.' },
      currency: { type: 'string', required: true, description: 'Currency code shared by every amount, such as EUR.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (!/^[A-Z]{3}$/.test(args.currency)) throw new Error('Supply a three-letter uppercase currency code')
      if (args.amounts.length === 0 || args.amounts.length > 1000) throw new Error('Supply between 1 and 1000 amounts')
      const opening = minorUnits(args.opening_balance ?? '0.00')
      let balance = opening
      const balances = args.amounts.map((amount) => { balance += minorUnits(amount); return decimalAmount(balance) })
      return { currency: args.currency, opening_balance: decimalAmount(opening), total_change: decimalAmount(balance - opening), closing_balance: decimalAmount(balance), balances, validation: 'exact_decimal_arithmetic; source_inputs_not_verified' }
    },
  })))
}
