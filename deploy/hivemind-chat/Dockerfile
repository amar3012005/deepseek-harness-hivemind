FROM node:24-bookworm-slim AS build
ENV CI=true
WORKDIR /opt/deepseek-harness
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DSH_HOME=/var/lib/dsh PORT=3080
WORKDIR /opt/deepseek-harness
COPY --from=build /opt/deepseek-harness /opt/deepseek-harness
COPY deploy/hivemind-chat/entrypoint.sh /usr/local/bin/hivemind-harness-entrypoint
RUN chmod 0755 /usr/local/bin/hivemind-harness-entrypoint && mkdir -p /var/lib/dsh && chown -R node:node /var/lib/dsh
USER node
EXPOSE 3080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["hivemind-harness-entrypoint"]
