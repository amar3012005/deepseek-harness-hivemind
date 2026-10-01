# Agent Note: Native HIVEMIND live voice

Status: implemented

English | [中文](2026-10-01-hivemind-live-voice.zh.md)

## Problem

Composer dictation only creates text. A live company-brain conversation needs natural audio, the authenticated company persona, and existing governed tools. Launching an unrelated Codex task would split identity, receipts and permissions.

## Decision

The HIVE runner mounts an authenticated Cordis WebRTC bridge. GPT-Live handles speech and ordinary conversation; client delegations enter the existing native Session. The runtime supplies compact profiles through an agent-scoped event. The waveform button owns microphone and peer lifetimes, while typed drafts keep the existing send action. Server OAuth credentials never enter browser state.

The subscription adapter uses the Codex v3 protocol and the `cove` voice. It bounds rooms, context, payloads and lifetime. Context appends respect the wire's 500-byte UTF-8 limit. Company write and connector authorization stay with the native tools; a spoken result follows the durable agent turn result.

## Alternatives considered

**Codex App Server as a second task runtime.** Its automatic backing-agent handoffs would duplicate the existing Harness agent and its authorization path. The direct control channel delegates into the already authenticated Session.

**Dictation plus text-to-speech.** That preserves a simpler integration but does not provide the requested GPT-Live conversation and interruption behavior.

## Consequences

The native composition works across tenants without per-tenant plugin setup. Access still depends on an authorized subscription credential and provider availability. The experimental protocol needs live transport checks when changed. A voice shutdown cancels control-channel listeners, while an accepted native task remains resumable in its original conversation.

## Testing

Focused composer tests cover draft switching, microphone cancellation and cleanup. A real Loader fixture covers native service activation, anonymous and origin rejection, and tenant scope before Session admission. Isolated subscription probes confirm audio and client-delegation delivery with synthetic speech and fixture results; they do not read or write real company memories.
