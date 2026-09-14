# Standalone memory save schema

## Problem

The HIVE save executor correctly required `related_to` whenever `relationship` was set, but the model-facing fields did not explain when both fields must be omitted. A new profile memory could therefore make one rejected `extend` attempt before retrying as the intended standalone save.

## Resolution

The `hivemind_meta` schema and HIVE persona now identify standalone saves as the default for new facts. Relationship saves remain restricted to an exact recalled memory UUID. The executor validation is unchanged, so incomplete or text-based relationship references still fail before a network request.
