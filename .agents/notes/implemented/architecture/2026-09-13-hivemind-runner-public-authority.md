# Agent Note: HIVE runner uses the proxy-pinned public authority

Status: implemented

English | [中文](2026-09-13-hivemind-runner-public-authority.zh.md)

## Problem

The embedded HIVE runner may sit behind a Worker and a tunnel. The tunnel can append its transport hostname to `x-forwarded-host` even when its upstream `Host` is pinned to the browser-visible application. Choosing the forwarded value first rejects a valid parent origin and can bind Connection-cookie verification to the wrong authority.

## Decision

The deployment reverse proxy pins upstream `Host` to the browser-visible application authority. The runner uses `Host` for same-origin admission, Connection-cookie creation, and authenticated browser boot. It reads the first `x-forwarded-host` value only when `Host` is absent.

The ticket and its Redis nonce remain mandatory. The authority choice does not grant admission by itself and does not weaken the explicit parent-origin allowlist.

## Alternatives considered

**Trust `x-forwarded-host` first.** Rejected because a transport proxy may prepend or append a hostname that the browser never sees.

**Add another shared edge secret and custom authority header.** Rejected because the signed one-time ticket, nonce consumption, parent-origin allowlist, and trusted proxy Host already authenticate and constrain this path; another secret would duplicate deployment state without strengthening the decision.

## Consequences

Reverse proxies must set `Host` deliberately rather than pass an arbitrary client value. Direct loopback use retains the ordinary request Host, and deployments without a Host value retain the forwarded-host fallback.
