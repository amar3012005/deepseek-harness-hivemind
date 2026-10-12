# Runtime administrator email

`runtime-administrator.html` saves the version-1 Runtime composition inside Harness. It is an email-safe template reference with named placeholders and the existing SINGULANCE brand shell. Production rendering reuses Core's canonical `core/src/email/templates/runtime-administrator.js` and shared `singulance-transactional.js`; the model does not supply arbitrary HTML.

The native `hivemind_administrator_message` tool sends structured message content through the existing signed Harness-to-Core boundary. Core resolves the authenticated administrator, checks preference and authority, saves one durable message, and calls the existing Cloudflare sender. Accepted sender receipts do not prove mailbox delivery, reading or approval. Unknown sends are retained for reconciliation, never automatically regenerated.

Decision and approval messages reference existing native questions/approvals and link to the authenticated Runtime conversation. Email links never approve an action. Direct HyperAgent chats and native Teams remain unchanged; employees report to Runtime, which reviews results and decides whether the administrator needs a message.
