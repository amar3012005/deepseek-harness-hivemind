import {defineConfig} from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import {standardDecoratorPlugin,vitestExecArgv} from './vitest.shared.ts'
export default defineConfig({cacheDir:'/tmp/vite',plugins:[standardDecoratorPlugin(),tsconfigPaths({projects:['/opt/deepseek-harness/tsconfig.base.json']})],test:{include:['packages/hivemind/hq-runtime/tests/media-native-postgres.spec.ts','packages/hivemind/hq-runtime/tests/service-recovery.spec.ts'],pool:'forks',maxWorkers:1,execArgv:vitestExecArgv,cache:false,testTimeout:20000}})
