# k3-harness

One k3s cluster, **Harness runner pods only**. Core, Control Plane, Postgres, Redis stay on the main HIVE box.

```bash
git clone https://github.com/amar3012005/deepseek-harness-hivemind.git
cd deepseek-harness-hivemind
git checkout k3-harness
cp deploy/k3-harness/env.example deploy/k3-harness/.env
# set Box-A private IPs and ticket secrets
./deploy/k3-harness/k3-harness-up.sh
```

Linux installs k3s if missing. macOS uses k3d. Builds this repo’s `deploy/hivemind-chat/Dockerfile`, loads it into the cluster, applies manifests.

Each pod: 2Gi RAM cap, crash restart, HPA 1–4. Cluster name: `k3-harness`.
