import { defineConfig } from 'tsdown'

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
  },
])
