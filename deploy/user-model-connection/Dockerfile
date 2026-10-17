ARG BRAIN_BASE
FROM ${BRAIN_BASE}
USER root
WORKDIR /opt/deepseek-harness
COPY packages/hivemind/web-runner/ packages/hivemind/web-runner/
COPY packages/bundle/hivemind-web-app/cordis.patch.yml packages/bundle/hivemind-web-app/cordis.patch.yml
RUN node node_modules/typescript/bin/tsc -b packages/hivemind/web-runner \
 && node node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE host --filter @deepseek-ai/dsh-hivemind-web-runner
ARG SOURCE_SHA
LABEL org.opencontainers.image.revision=$SOURCE_SHA com.singulance.scope=brain-user-model-connection
USER node
