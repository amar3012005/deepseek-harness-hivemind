# SINGULANCE BYOD Harness overlay

Dedicated branch: `singulance-byod`.

This is the **Memory Box** runner image overlay (native Harness UI on the
customer box). It is not Engine Box (`singulance-selfhost`).

HIVEMIND repo counterpart: branch `singulance-byod`, folder `byod/hyperagent`
(Compose, enroll, Cloudflare `hr-<org>` hostname).

```bash
docker build -f deploy/singulance-byod/Dockerfile -t hivemind/harness-chat:byod-hyperagent deploy/singulance-byod
```

The Dockerfile `FROM`s the existing `hivemind-chat` runner and applies:

- all shipped agent modes
- org/user filesystem sandbox
- SINGULANCE chrome
- host settings on the public URL
- no auto skill-catalog dump
