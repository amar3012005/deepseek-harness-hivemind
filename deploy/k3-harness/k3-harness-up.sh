#!/usr/bin/env bash
# Bring up a Harness-only k3s cluster on this machine.
# Does not install Core, Control Plane, or Postgres.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLUSTER="${K3_HARNESS_CLUSTER:-k3-harness}"
NS=hivemind-harness
ENV_FILE="${K3_HARNESS_ENV:-$HERE/.env}"
RENDER="$HERE/.render"
OS="$(uname -s)"

log() { printf '[k3-harness] %s\n' "$*"; }
die() { printf '[k3-harness] ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing $1"; }

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  elif [[ -f "$HERE/env.example" ]]; then
    log "no $ENV_FILE — using env.example defaults"
    set -a
    # shellcheck disable=SC1091
    source "$HERE/env.example"
    set +a
  fi
  : "${POSTGRES_HOST:?set POSTGRES_HOST in deploy/k3-harness/.env}"
  : "${REDIS_HOST:?set REDIS_HOST}"
  : "${CONTROL_PLANE_HOST:?set CONTROL_PLANE_HOST}"
  : "${CORE_HOST:?set CORE_HOST}"
  POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  REDIS_PORT="${REDIS_PORT:-6379}"
  CONTROL_PLANE_PORT="${CONTROL_PLANE_PORT:-3000}"
  CORE_PORT="${CORE_PORT:-3000}"
  HARNESS_MIN_REPLICAS="${HARNESS_MIN_REPLICAS:-1}"
  HARNESS_MAX_REPLICAS="${HARNESS_MAX_REPLICAS:-4}"
  DATABASE_URL="${DATABASE_URL:-postgresql://hivemind:hivemind_dev_password@postgres:5432/hivemind_app}"
  REDIS_URL="${REDIS_URL:-redis://redis:6379/0}"
  HIVEMIND_CONTROL_PLANE_URL="${HIVEMIND_CONTROL_PLANE_URL:-http://control-plane:3000}"
  HIVEMIND_SERVICE_HTTP_ORIGINS="${HIVEMIND_SERVICE_HTTP_ORIGINS:-http://control-plane:3000}"
  HIVEMIND_PARENT_ORIGINS="${HIVEMIND_PARENT_ORIGINS:-https://next.preview.singulancelabs.com}"
  HIVEMIND_HARNESS_TRUSTED_HOSTS="${HIVEMIND_HARNESS_TRUSTED_HOSTS:-next.preview.singulancelabs.com,harness-preview.singulancelabs.com}"
}

resolve_ip() {
  local host="$1"
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s' "$host"
    return
  fi
  python3 -c "import socket,sys; print(socket.gethostbyname(sys.argv[1]))" "$host"
}

ensure_k3s_linux() {
  if command -v k3s >/dev/null 2>&1 && [[ -f /etc/rancher/k3s/k3s.yaml ]]; then
    log "k3s already installed"
  else
    need_cmd curl
    log "installing k3s"
    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
  fi
  export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
  if [[ ! -r "$KUBECONFIG" ]]; then
    sudo chmod 644 /etc/rancher/k3s/k3s.yaml || true
  fi
  if ! command -v kubectl >/dev/null 2>&1; then
    sudo ln -sf /usr/local/bin/kubectl /usr/local/bin/kubectl 2>/dev/null || true
    alias kubectl='sudo k3s kubectl'
  fi
  KUBECTL=(kubectl)
  if ! kubectl get nodes >/dev/null 2>&1; then
    KUBECTL=(sudo k3s kubectl)
  fi
}

ensure_k3d_macos() {
  if ! command -v k3d >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      brew install k3d
    else
      curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
    fi
  fi
  need_cmd kubectl
  need_cmd docker
  if ! k3d cluster list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$CLUSTER"; then
    local net="${K3D_NETWORK:-hivemind-network}"
    local net_args=()
    if docker network inspect "$net" >/dev/null 2>&1; then
      net_args=(--network "$net")
    fi
    k3d cluster create "$CLUSTER" \
      "${net_args[@]}" \
      --servers 1 \
      --agents "${K3D_AGENTS:-1}" \
      --k3s-arg "--disable=traefik@server:0"
  fi
  kubectl config use-context "k3d-${CLUSTER}"
  KUBECTL=(kubectl)
}

build_image() {
  need_cmd docker
  local sha
  sha="$(git -C "$REPO" rev-parse HEAD)"
  HARNESS_IMAGE="${HARNESS_IMAGE:-hivemind/harness-chat:${sha}}"
  export HARNESS_IMAGE
  if docker image inspect "$HARNESS_IMAGE" >/dev/null 2>&1; then
    log "image exists $HARNESS_IMAGE"
    return
  fi
  log "building $HARNESS_IMAGE"
  docker build \
    -f "$REPO/deploy/hivemind-chat/Dockerfile" \
    --build-arg "DSH_CLIENT_COMMIT_HASH=$sha" \
    -t "$HARNESS_IMAGE" \
    "$REPO"
}

load_image() {
  log "loading $HARNESS_IMAGE into cluster"
  if [[ "$OS" == Darwin ]]; then
    k3d image import "$HARNESS_IMAGE" -c "$CLUSTER"
  else
    docker save "$HARNESS_IMAGE" | sudo k3s ctr images import -
  fi
}

render() {
  mkdir -p "$RENDER"
  POSTGRES_HOST="$(resolve_ip "$POSTGRES_HOST")"
  REDIS_HOST="$(resolve_ip "$REDIS_HOST")"
  CONTROL_PLANE_HOST="$(resolve_ip "$CONTROL_PLANE_HOST")"
  CORE_HOST="$(resolve_ip "$CORE_HOST")"
  export POSTGRES_HOST POSTGRES_PORT REDIS_HOST REDIS_PORT
  export CONTROL_PLANE_HOST CONTROL_PLANE_PORT CORE_HOST CORE_PORT
  export DATABASE_URL REDIS_URL HIVEMIND_CONTROL_PLANE_URL HIVEMIND_SERVICE_HTTP_ORIGINS
  export HIVEMIND_PARENT_ORIGINS HIVEMIND_HARNESS_TRUSTED_HOSTS
  export HARNESS_IMAGE HARNESS_MIN_REPLICAS HARNESS_MAX_REPLICAS
  python3 - <<'PY'
import os, pathlib, re
src = pathlib.Path(os.environ["HERE"]) / "manifests"
dst = pathlib.Path(os.environ["RENDER"])
pat = re.compile(r"\$\{([A-Z0-9_]+)\}")
def repl(m):
    v = os.environ.get(m.group(1))
    if v is None:
        raise SystemExit(f"missing env {m.group(1)}")
    return v
for path in src.glob("*.yaml"):
    text = pat.sub(repl, path.read_text())
    (dst / path.name).write_text(text)
PY
}

apply() {
  "${KUBECTL[@]}" apply -f "$RENDER/namespace.yaml"
  if [[ -f "$ENV_FILE" ]]; then
    "${KUBECTL[@]}" -n "$NS" create secret generic harness-env \
      --from-env-file="$ENV_FILE" \
      --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
  fi
  "${KUBECTL[@]}" apply -f "$RENDER"
  "${KUBECTL[@]}" -n "$NS" rollout status deploy/harness-runner --timeout=180s
  "${KUBECTL[@]}" -n "$NS" get nodes,pods,svc,hpa -o wide 2>/dev/null || \
    "${KUBECTL[@]}" -n "$NS" get pods,svc,hpa
  log "health: kubectl -n $NS exec deploy/harness-runner -- wget -qO- http://127.0.0.1:3080/health"
}

load_env
export HERE RENDER

if [[ "$OS" == Darwin ]]; then
  ensure_k3d_macos
else
  ensure_k3s_linux
fi

build_image
load_image
render
apply
log "done cluster=$CLUSTER namespace=$NS image=$HARNESS_IMAGE"
