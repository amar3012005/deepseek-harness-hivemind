#!/usr/bin/env node
/** Isolated dsh lab gateway. No HIVE Core, no tenant DB, no live runner. */
import http from 'node:http'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.PORT || 8080)
const SHA = String(process.env.DSH_SANDBOX_SHA || 'unknown')
const ROOT = process.env.DSH_SANDBOX_ROOT || '/sandbox-rooms'
const MODEL_KEY = String(process.env.DSH_SANDBOX_MODEL_KEY || '').trim()

async function json(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-dsh-sandbox-sha': SHA,
  })
  res.end(payload)
}

async function runHeadless(id, prompt) {
  if (!MODEL_KEY) {
    return { skipped: true, reason: 'no_model_key', text: '' }
  }
  return await new Promise((resolve) => {
    const child = spawn('pnpm', ['dsh', '--profile', 'headless', prompt], {
      cwd: process.env.DSH_SOURCE_ROOT || '/opt/dsh',
      env: { ...process.env, DEEPSEEK_API_KEY: MODEL_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ skipped: false, code, text: stdout.trim(), stderr: stderr.slice(-4000) })
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'hivemind-dsh-sandbox',
        sha: SHA,
        model_key: MODEL_KEY ? 'present' : 'absent',
      })
    }
    if (req.method === 'POST' && (url.pathname === '/run' || url.pathname === '/webhook')) {
      const body = await json(req)
      const id = randomUUID()
      const dir = join(ROOT, id)
      await mkdir(dir, { recursive: true })
      const fixture = {
        id,
        sha: SHA,
        created_at: new Date().toISOString(),
        prompt: typeof body.prompt === 'string' ? body.prompt : 'branding fixture',
        fixture: body,
      }
      await writeFile(join(dir, 'input.json'), JSON.stringify(fixture, null, 2))
      const result = await runHeadless(id, fixture.prompt)
      const record = { ...fixture, ...result, status: result.skipped ? 'skipped' : (result.code === 0 ? 'completed' : 'failed') }
      await writeFile(join(dir, 'result.json'), JSON.stringify(record, null, 2))
      await writeFile(join(dir, 'final.txt'), record.text || '')
      return send(res, 202, {
        id,
        status: record.status,
        sha: SHA,
        skipped: Boolean(result.skipped),
        reason: result.reason || null,
        text: record.text || '',
        observe: `/runs/${id}`,
      })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const id = url.pathname.slice('/runs/'.length).split('/')[0]
      if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, { error: 'invalid_id' })
      const result = JSON.parse(await readFile(join(ROOT, id, 'result.json'), 'utf8'))
      return send(res, 200, result)
    }
    if (req.method === 'GET' && url.pathname === '/runs') {
      const ids = await readdir(ROOT).catch(() => [])
      return send(res, 200, { sha: SHA, runs: ids })
    }
    return send(res, 404, { error: 'not_found' })
  } catch (error) {
    return send(res, 500, { error: String(error.message || error) })
  }
})

await mkdir(ROOT, { recursive: true })
server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`hivemind-dsh-sandbox ${SHA} listening on ${PORT}\n`)
})
