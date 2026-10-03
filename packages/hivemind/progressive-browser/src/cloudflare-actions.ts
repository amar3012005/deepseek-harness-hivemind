/** Cloudflare Think 0.19.0 / Agents 0.24.0 quick-action contracts and native transport. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export interface ActionConfig { accountId: string; browserToken: string; gatewayId: string; gatewayToken: string }
export const actionContracts: { name: string; description: string; parameters: Record<string, unknown> }[] = [
  {
    'name': 'browser_markdown',
    'description': 'Load a web page (or render raw HTML) and return its content as Markdown. Best for reading articles, docs, or any page as text.',
    'parameters': {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      'type': 'object',
      'properties': {
        'url': {
          'description': 'URL of the page to load',
          'type': 'string',
          'format': 'uri',
        },
        'html': {
          'description': 'Raw HTML to render instead of loading a URL',
          'type': 'string',
        },
      },
      'additionalProperties': false,
    },
  },
  {
    'name': 'browser_extract',
    'description': "Extract structured data from a web page using AI. Describe what you want in 'prompt'. Passing a JSON Schema in 'schema' is strongly recommended — without one the extractor often fails to produce JSON.",
    'parameters': {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      'type': 'object',
      'properties': {
        'url': {
          'description': 'URL of the page to load',
          'type': 'string',
          'format': 'uri',
        },
        'html': {
          'description': 'Raw HTML to render instead of loading a URL',
          'type': 'string',
        },
        'prompt': {
          'description': 'What to extract, in natural language',
          'type': 'string',
        },
        'schema': {
          'description': 'Optional JSON Schema describing the desired output',
          'type': 'object',
          'propertyNames': {
            'type': 'string',
          },
          'additionalProperties': {},
        },
      },
      'additionalProperties': false,
    },
  },
  {
    'name': 'browser_links',
    'description': 'Return every link found on a web page (including ones not visible). Useful for discovering pages to follow.',
    'parameters': {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      'type': 'object',
      'properties': {
        'url': {
          'description': 'URL of the page to load',
          'type': 'string',
          'format': 'uri',
        },
        'html': {
          'description': 'Raw HTML to render instead of loading a URL',
          'type': 'string',
        },
      },
      'additionalProperties': false,
    },
  },
  {
    'name': 'browser_scrape',
    'description': "Scrape specific elements from a web page by CSS selector. Returns the matched elements' text, HTML, and attributes.",
    'parameters': {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      'type': 'object',
      'properties': {
        'url': {
          'description': 'URL of the page to load',
          'type': 'string',
          'format': 'uri',
        },
        'html': {
          'description': 'Raw HTML to render instead of loading a URL',
          'type': 'string',
        },
        'selectors': {
          'minItems': 1,
          'type': 'array',
          'items': {
            'type': 'string',
          },
          'description': 'CSS selectors to extract',
        },
      },
      'required': [
        'selectors',
      ],
      'additionalProperties': false,
    },
  },
  {
    'name': 'parallel_search',
    'description': 'Search the web through Parallel AI Gateway and return URL citations.',
    'parameters': {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      'type': 'object',
      'properties': {
        'query': {
          'type': 'string',
          'minLength': 3,
          'maxLength': 1200,
        },
      },
      'required': [
        'query',
      ],
      'additionalProperties': false,
    },
  },
  {
    'name': 'browser_capture',
    'description': 'Capture a public HTTPS webpage with Cloudflare Browser Run and save the PNG as an artifact in this turn.',
    'parameters': {
      '$schema': 'http://json-schema.org/draft-07/schema#',
      'type': 'object',
      'properties': {
        'url': {
          'type': 'string',
          'format': 'uri',
        },
        'title': {
          'type': 'string',
          'minLength': 3,
          'maxLength': 120,
        },
      },
      'required': [
        'url',
      ],
      'additionalProperties': false,
    },
  },
]

function publicUrl(value: string, httpsOnly = false): string {
  const url = new URL(value)
  if (!(httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.|169\.254\.)/i.test(url.hostname)) throw new Error('public_url_required')
  return url.href
}

function bound(value: JsonValue): JsonValue {
  const limit = 16000
  if (typeof value === 'string') return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} characters]`
  if (JSON.stringify(value).length <= limit) return value
  if (Array.isArray(value)) {
    const trimmed = [...value]
    while (trimmed.length && JSON.stringify(trimmed).length > limit) trimmed.pop()
    if (trimmed.length) return trimmed
  }
  const json = JSON.stringify(value)
  return { truncated: true, note: `Result is too large (${json.length} characters); narrow the request.`, preview: `${json.slice(0, limit)}…` }
}

/** Execute only stateless provider operations; the native agent owns all reasoning and receipts. */
export async function executeAction(
  config: ActionConfig, name: string, args: Record<string, JsonValue>, signal: AbortSignal,
): Promise<JsonValue | Uint8Array> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)])
  if (name === 'parallel_search') {
    if (typeof args.query !== 'string' || args.query.length < 3 || args.query.length > 1200) throw new Error('invalid_search_query')
    if (!config.gatewayToken) throw new Error('parallel_gateway_unconfigured')
    const response = await fetch(`https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/parallel/v1beta/search`, {
      method: 'POST', headers: { 'x-api-key': config.gatewayToken, 'content-type': 'application/json' },
      body: JSON.stringify({ objective: args.query.slice(0, 500), processor: 'base', max_results: 10, max_chars_per_result: 700 }), signal: requestSignal,
    })
    if (!response.ok) return { error: 'parallel_search_failed', status: response.status }
    const payload = await response.json() as { results?: { title?: string; url?: string; text?: string; content?: string }[] }
    return { provider: 'parallel-ai-gateway', results: (payload.results ?? []).map(row => ({ title: (row.title ?? '').slice(0, 300), url: (row.url ?? '').slice(0, 1000), snippet: String(row.text ?? row.content ?? '').slice(0, 700) })).filter(row => /^https?:\/\//.test(row.url)) }
  }
  const actions: Record<string, string> = { browser_markdown: 'markdown', browser_extract: 'json', browser_links: 'links', browser_scrape: 'scrape', browser_capture: 'screenshot' }
  const action = actions[name]
  if (!action) throw new Error('unknown_browser_action')
  if (!args.url && !args.html) throw new Error("Provide either 'url' or 'html'")
  const body: Record<string, JsonValue> = typeof args.url === 'string' ? { url: publicUrl(args.url, name === 'browser_capture') } : { html: args.html ?? '' }
  if (name === 'browser_extract') {
    if (!args.prompt && !args.schema) throw new Error("Provide either 'prompt' or 'schema'")
    if (args.prompt !== undefined) body.prompt = args.prompt
    if (args.schema !== undefined) body.response_format = { type: 'json_schema', json_schema: args.schema }
  }
  if (name === 'browser_scrape') {
    if (!Array.isArray(args.selectors) || !args.selectors.length || args.selectors.some(value => typeof value !== 'string')) throw new Error('selectors_required')
    body.elements = args.selectors.map(selector => ({ selector }))
  }
  // Keep captures within native image dimension limits, including very long pages.
  if (name === 'browser_capture') body.screenshotOptions = { fullPage: false, type: 'png' }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/browser-rendering/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.browserToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: requestSignal,
  })
  if (!response.ok) throw new Error(`Browser Run ${action} failed (${response.status})`)
  if (name === 'browser_capture') {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length < 8 || bytes.length > 20 * 1024 * 1024 || ![137,80,78,71].every((byte, index) => bytes[index] === byte)) throw new Error(`capture_invalid_or_too_large: ${bytes.length} bytes, ${response.headers.get('content-type')}`)
    return bytes
  }
  const payload = await response.json() as { success?: boolean; result?: JsonValue }
  if (payload.success === false || payload.result === undefined) throw new Error(`Browser Run ${action} returned no result`)
  return bound(payload.result)
}
