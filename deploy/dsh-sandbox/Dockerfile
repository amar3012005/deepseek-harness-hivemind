FROM node:22-bookworm-slim
WORKDIR /opt/dsh-sandbox
COPY server.mjs /opt/dsh-sandbox/server.mjs
ENV NODE_ENV=production
ENV PORT=8080
ENV DSH_SANDBOX_ROOT=/sandbox-rooms
EXPOSE 8080
VOLUME ["/sandbox-rooms"]
USER node
CMD ["node", "/opt/dsh-sandbox/server.mjs"]
