/** Build exact native source for isolated HTTP/curl inference proof. */
import {resolve} from 'node:path';
export default {entry:{decision:resolve('packages/hivemind/decision/src/index.ts'),policy:resolve('packages/hivemind/hq-runtime/src/attention-policy.ts')},outDir:process.env.DECISION_CANARY_OUT_DIR||'/tmp/native-decision-http-canary',platform:'node',format:'esm',deps:{alwaysBundle:['zod'],neverBundle:[/^@deepseek-ai\//]},dts:false};
