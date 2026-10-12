FROM node:24-bookworm-slim AS build
ENV CI=true
WORKDIR /opt/deepseek-harness
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
ARG DSH_CLIENT_TITLE="SINGULANCE · HIVE-MIND"
ENV DSH_CLIENT_TITLE=${DSH_CLIENT_TITLE}
COPY . .
RUN test -n "${DSH_CLIENT_COMMIT_HASH}"
RUN --mount=type=cache,id=deepseek-harness-pnpm,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile
RUN pnpm run build
# Cordis resolves profile rows from the loader package. Materialize all built
# workspace packages at the root so HIVE include files share one native module
# graph in the immutable image.
RUN set -eu; \
  mkdir -p /opt/deepseek-harness/node_modules/@deepseek-ai; \
  find apps packages vendor \
    \( -name node_modules -o -name lib -o -name dist \) -prune -o \
    -type f -name package.json -print | while IFS= read -r manifest; do \
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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ARG DSH_CLIENT_COMMIT_HASH
LABEL org.opencontainers.image.revision=${DSH_CLIENT_COMMIT_HASH}
LABEL com.singulance.service=harness-runner
ARG DSH_CLIENT_TITLE="SINGULANCE · HIVE-MIND"
ENV NODE_ENV=production DSH_HOME=/var/lib/dsh PORT=3080 DSH_CLIENT_TITLE=${DSH_CLIENT_TITLE} PLAYWRIGHT_BROWSERS_PATH=/opt/dsh-browsers
WORKDIR /opt/deepseek-harness
COPY --from=build /opt/deepseek-harness /opt/deepseek-harness
# The renderer requires the lockfile-matched Chromium and its shared libraries.
RUN node packages/hivemind/artifact-renderer/node_modules/playwright/cli.js install --with-deps chromium \
  && chmod -R a+rX /opt/dsh-browsers \
  && rm -rf /var/lib/apt/lists/*
COPY deploy/hivemind-chat/entrypoint.sh /usr/local/bin/hivemind-harness-entrypoint
COPY deploy/hivemind-chat/prepare-profile.sh /usr/local/bin/hivemind-harness-prepare-profile
RUN chmod 0755 /usr/local/bin/hivemind-harness-entrypoint \
  /usr/local/bin/hivemind-harness-prepare-profile \
  && mkdir -p /var/lib/dsh/hivemind-chat \
  && chown -R node:node /var/lib/dsh
USER node
RUN node -e "const {chromium}=require('./packages/hivemind/artifact-renderer/node_modules/playwright'); (async()=>{const b=await chromium.launch({headless:true});try{const p=await b.newPage({javaScriptEnabled:false});await p.setContent('<html><body>Renderer ready</body></html>');const pdf=await p.pdf();if(!pdf.length)throw Error('empty PDF')}finally{await b.close()}})().catch(e=>{console.error(e);process.exit(1)})"
EXPOSE 3080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["hivemind-harness-entrypoint"]
