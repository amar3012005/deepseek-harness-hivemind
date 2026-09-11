# k3-harness

One k3s cluster, **Harness runner pods only**. Core, Control Plane, Postgres, Redis stay on the main HIVE box.

## One script (any server)

```bash
git clone https://github.com/amar3012005/deepseek-harness-hivemind.git
cd deepseek-harness-hivemind
git checkout k3-harness
cp deploy/k3-harness/env.example deploy/k3-harness/.env
# edit deploy/k3-harness/.env — Box A private IPs + ticket secrets
chmod +x deploy/k3-harness/k3-harness-up.sh
./deploy/k3-harness/k3-harness-up.sh
```

That script is `deploy/k3-harness/k3-harness-up.sh`. It:

1. Installs **k3s** on Linux (or **k3d** on macOS) if missing
2. Builds this repo’s `deploy/hivemind-chat/Dockerfile`
3. Loads the image into the cluster
4. Applies namespace `hivemind-harness` (2Gi pods, crash restart, HPA 1–4)
5. Points `postgres` / `redis` / `control-plane` / `core` at Box A IPs from `.env`

Cluster name: `k3-harness`.

## `.env`

Copy `env.example` → `.env`. `POSTGRES_HOST`, `REDIS_HOST`, `CONTROL_PLANE_HOST`, and `CORE_HOST` must be **IPs** (or hostnames the script can resolve). Ticket secrets must match Control Plane.

## Check

```bash
kubectl get nodes
kubectl -n hivemind-harness get pods,svc,hpa
kubectl -n hivemind-harness exec deploy/harness-runner -- wget -qO- http://127.0.0.1:3080/health
```

## Tear down

```bash
# Linux k3s
sudo /usr/local/bin/k3s-uninstall.sh
# macOS k3d
k3d cluster delete k3-harness
```
