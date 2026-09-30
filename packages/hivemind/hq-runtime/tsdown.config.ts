import { defineConfig } from 'tsdown'
/** Agent capability and host human-control entry share native types and persistence. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/control.js'], outDir: 'lib',
  format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
