# @deepseek-ai/dsh-hivemind-web-runner

English | [中文](README.zh.md)

Profile-only host plugin for embedded HIVE chat. It verifies 60-second HMAC-SHA256 bootstrap tickets locally, consumes each Redis `jti` with atomic `GETDEL` under the shared `hive:harness-ticket:` namespace, mints the native Connection cookie with `Secure; HttpOnly; SameSite=None`, and returns no browser bearer token. `/health` checks Redis and PostgreSQL reachability without fabricating a tenant scope.

The ticket secret and Redis URL are read from named environment variables so resolved profile dumps never contain credentials. Parent origins are injected into the SPA as an explicit allowlist; ticket claims remain server-side.

`GET /api/hivemind/employees` uses the existing authenticated Connection principal and short-lived runner-to-control-plane token. It returns only authorized employee IDs, names, roles, avatar URLs and status for the HyperAgents picker; anonymous requests fail closed. No Core or Da-vinci frontend change is required.

## Live voice

The composer waveform button starts GPT-Live over WebRTC using the server's native `openai-codex` credential. Dictation remains available; a typed draft uses the ordinary send arrow. `liveVoice` enables the bridge for all authenticated HIVE tenants by default, with `gpt-live-1-codex` and the subscription voice `cove`. The default room lifetime is 15 minutes; the server admits one room per user and at most 20 simultaneous rooms. Missing authorization fails closed.

`POST /api/hivemind/voice/start` accepts `{sessionId,sdp}` and returns only `{id,sdp}`. It requires a Connection cookie, same-origin JSON, and a Session visible under the caller's organization. OAuth tokens stay on the server and refresh through the native credential service. Audio flows directly between the browser and OpenAI; the server retains an authenticated control channel.

Voice receives the deployment persona, a compact user/organization profile, and bounded recent conversation context. The runtime refreshes profile context on spoken user turns and before delegations. Every delegated lookup or action runs through the existing Session's agent and tools, preserving its access mode, approval rules, connector scopes, and durable receipts. Voice never creates a second Codex task agent or grants additional company-memory permissions.

Ordinary conversation and general questions stay with GPT-Live. Company-memory and connected-app delegations use the exact completed user transcript, including when delegation arrives before transcription finishes; the bridge does not use the model's rewritten task. Confirmed results use the v3 `speakable` channel, while profile refreshes use `commentary` context. Missing transcripts ask the user to repeat rather than executing a guessed query.

`POST /api/hivemind/voice/stop` accepts `{id}`. Ending voice or leaving the Session stops microphone tracks, closes the peer and control channel, removes event listeners, and retains completed transcripts as native context. Stopping voice leaves already accepted agent work available in the text conversation.

The subscription transport is experimental. Its wire version is pinned to the Codex v3 client-delegation contract (`OpenAI-Alpha: quicksilver=v2`); voice values must be compatible with that subscription route. Changing that contract requires another actual audio/delegation probe. A successful call admission alone does not establish that audio or delegated tool execution works.

## Known Limitations and Deferred Work

- Subscription voice requires an authorized server credential and compatible experimental transport; missing authorization fails closed.
