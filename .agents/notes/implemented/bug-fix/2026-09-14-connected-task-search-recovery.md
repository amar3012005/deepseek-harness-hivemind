# Connected-task search argument recovery

## Problem

A simple request to find recent email messages could enter `hivemind_connected_task` with the common `task` or `query`/`limit`/`order_by` vocabulary. The bridge exposed only its canonical multi-query vocabulary, so those calls failed before provider discovery. The next model step could then request schemas without a selected tool and incorrectly ask the user to identify an email provider.

## Resolution

The connected-app bridge now accepts a single-action `task` shorthand, conventional query fields, and an omitted initial session. It normalizes those values into the existing atomic Composio search request and retains the existing provider-selection, execution-contract, authorization, receipt, and idempotency rules. The HIVE persona explicitly continues a connected read into requested HIVE saves and forbids schema loading before search selects a tool.

## Scope

This change adds tolerance only at the model-facing tool JSON parser. It does not guess Gmail, execute an unselected provider tool, change external-write approval, or bypass the exact execution contract returned by discovery.
