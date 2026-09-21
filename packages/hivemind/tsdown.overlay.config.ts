import { defineConfig } from 'tsdown'
import { typertPlugin } from '../typert/generator/lib/types/tsdown-plugin.js'

// Compact release overlay: bundle only the two changed HIVE plugins after their
// TypeScript declarations have been emitted. This deliberately avoids a full
// Harness rebuild and preserves the runtime's existing streaming transport.
export default defineConfig([
  {
    entry: ['decision-gateway/lib/types/index.js'],
    outDir: 'decision-gateway/lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  },
  {
    entry: ['connected-apps/lib/types/index.js'],
    outDir: 'connected-apps/lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { alwaysBundle: ['@composio/core', 'ajv'] },
    plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  },
])
