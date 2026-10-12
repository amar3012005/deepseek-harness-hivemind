# @deepseek-ai/dsh-hivemind-identity

Defines `ctx.hivemindIdentity`, the authenticated tenant identity seam. The provider reads the local browser-issued credential and resolves user and organization scope server-side. Model tools never accept tenant identifiers.

## Model Experience

- **Visible tools:** none.
- **Prompt cost:** none.
- **KV-cache effect:** none.

## Known Limitations and Deferred Work

The compatibility runtime remains the local credential provider while the browser login transport is extracted separately.
