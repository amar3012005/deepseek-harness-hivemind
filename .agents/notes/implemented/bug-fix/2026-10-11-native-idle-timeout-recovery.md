# Agent Note: Native idle timeout recovery

Status: implemented

English | [中文](2026-10-11-native-idle-timeout-recovery.zh.md)

## Problem

An idle watchdog that only aborts a signal leaves an uncooperative provider read pending. Awaiting the async generator’s teardown queues another wait behind that read, so the native loop never receives its timeout and cannot recover the saved work.

## Decision

The existing timeout utility uses the official `dsh-v0.2.1-alpha.2` demand settlement: its own idle deadline rejects the outstanding demand independently of provider cooperation. The stable signal still owns resource termination. The pi-ai adapter initiates generator teardown without awaiting an abandoned read and translates the exact rejected watchdog reason to native `TIMEOUT`; explicit caller cancellation retains `ABORTED`. Existing provider retry policy and Session history own continuation. No new scheduler, recovery queue or message replay is added.

## Alternatives considered

**Wait for provider teardown.** Rejected because a noncooperative read can prevent the deadline from reaching the caller indefinitely.

**Replay the initiating message or completed tools.** Rejected because native Session results retain already completed outcomes and remain the recovery authority.

## Consequences

The change settles an abandoned demand without claiming that an external provider stopped its work. Capability owners retain their transport cancellation and cleanup. Consumer think time does not count toward idle time, pulses rearm pending reads, and total deadlines remain a separate contract. A managed restart of confirmed stale production work requires preserved before/after receipts and native restoration; source tests are not live recovery proof.

## Testing

A noncooperative SDK iterator reproduces the unbounded wait before the fix and receives native `TIMEOUT` afterward. Timeout utility and pi-ai adapter fixtures cover deadlines, pulses, caller cancellation, credential errors and ordinary streaming. DeepSeek adapter fixtures validate the other idle-watchdog consumer.
