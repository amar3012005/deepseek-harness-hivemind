# Isolated dsh sandbox

Lab only. This compose project is `dsh-sandbox`. It must never join the live
HIVEMIND / Harness runner / Employees stack.

- Image: `hivemind/dsh-sandbox:sha-<short>`
- Service: `hivemind-dsh-sandbox`
- Network: `dsh_sandbox_net`
- Volume: `dsh_sandbox_rooms` to `/sandbox-rooms`
- Listen: `127.0.0.1:18080`

Forbidden: live runner mounts, Enigma/Postgres, HyperAgent SSE, `--remove-orphans`,
copied production keys.

```sh
export DSH_SANDBOX_SHA=$(git rev-parse HEAD)
export DSH_SANDBOX_TAG=sha-$(git rev-parse --short HEAD)
# Own secret. Never copy from production.
docker compose -p dsh-sandbox -f deploy/dsh-sandbox/docker-compose.sandbox.yml up -d --build
curl -sS http://127.0.0.1:18080/health
curl -sS -X POST http://127.0.0.1:18080/run -H 'content-type: application/json' \
  -d '{"prompt":"branding fixture"}'
```

Rebuild rule: push a SHA, build `hivemind/dsh-sandbox:sha-<short>`, recreate only
`hivemind-dsh-sandbox`.
