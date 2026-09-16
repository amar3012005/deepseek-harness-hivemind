FROM node:22-bookworm-slim
WORKDIR /opt/dsh-sandbox
COPY server.mjs /opt/dsh-sandbox/server.mjs
RUN mkdir -p /sandbox-rooms && chown node:node /sandbox-rooms
ENV NODE_ENV=production
ENV PORT=8080
ENV DSH_SANDBOX_ROOT=/sandbox-rooms
EXPOSE 8080
USER node
CMD ["node", "/opt/dsh-sandbox/server.mjs"]
