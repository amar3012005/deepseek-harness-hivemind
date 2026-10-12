import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Use the native naming implementation without importing an unpublished source file.
  noExternal: ['@deepseek-ai/dsh-mcp-client/src/tools.ts'],
})
