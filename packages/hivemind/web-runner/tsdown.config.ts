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
  // This native helper is exported from source but excluded from published files.
  noExternal: ['@deepseek-ai/dsh-llm-pi-ai/src/auth.ts'],
})
