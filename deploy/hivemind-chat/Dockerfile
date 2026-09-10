FROM node:24-bookworm-slim AS build
ENV CI=true
WORKDIR /opt/deepseek-harness
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
COPY . .
RUN test -n "${DSH_CLIENT_COMMIT_HASH}"
RUN --mount=type=cache,id=deepseek-harness-pnpm,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile
RUN pnpm run build
# Cordis resolves profile rows from its loader package, so the production
# image needs the complete workspace package graph at the repository root.
# pnpm only hoists root-declared workspaces there; materialize the same stable
# links for every built @deepseek-ai package used by shipped compositions.
RUN set -eu; \
  mkdir -p /opt/deepseek-harness/node_modules/@deepseek-ai; \
  find apps packages vendor -name package.json -type f | while IFS= read -r manifest; do \
    name="$(node -p "require('./$manifest').name || ''")"; \
    case "$name" in \
      @deepseek-ai/*) \
        package="${name#@deepseek-ai/}"; \
        target="/opt/deepseek-harness/${manifest%/package.json}"; \
        ln -sfn "$target" "/opt/deepseek-harness/node_modules/@deepseek-ai/$package"; \
        ;; \
    esac; \
  done

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DSH_HOME=/var/lib/dsh PORT=3080
WORKDIR /opt/deepseek-harness
COPY --from=build /opt/deepseek-harness /opt/deepseek-harness
COPY deploy/hivemind-chat/entrypoint.sh /usr/local/bin/hivemind-harness-entrypoint
RUN chmod 0755 /usr/local/bin/hivemind-harness-entrypoint \
  && mkdir -p /var/lib/dsh/hivemind-chat \
  && chown -R node:node /var/lib/dsh
USER node
EXPOSE 3080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["hivemind-harness-entrypoint"]
