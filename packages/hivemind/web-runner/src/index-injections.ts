/** HIVE-owned HTML rows shared by standalone rendering and authenticated boot. */
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

export const HIVEMIND_ROOT_BASE_INJECTION: IndexInjection = {
  kind: 'script', placement: 'head',
  // frontend-static prepends its generic `./` base after rendering injection
  // rows. Update the effective first base synchronously before resource refs.
  text: "(()=>{let base=document.querySelector('base');if(!base){base=document.createElement('base');document.head.prepend(base)}base.setAttribute('href','/')})()",
}

/** Register root-relative resources for HIVE's path-mounted native chat documents. */
export function registerHivemindIndexInjections(ctx: Context, parentOrigins: readonly string[]): void {
  ctx.on('webserver/index-inject', (table) => {
    table.unshift(HIVEMIND_ROOT_BASE_INJECTION)
    table.push(
      {
        kind: 'global',
        name: '__HIVEMIND_EMBED_CONFIG__',
        value: { version: 1, parentOrigins },
      },
    )
  })
}
