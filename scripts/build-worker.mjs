// Bundle the reference worker into one file agents can download and run with
// plain node: no install step, no dependencies. The API serves the result at
// /work/said-worker.cjs. Run: node scripts/build-worker.mjs
import { build } from 'esbuild';

await build({
  entryPoints: ['worker/said-worker.ts'],
  outfile: 'dist/said-worker.cjs',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // A bundled dependency still requires node's deprecated `punycode`; the
  // warning it prints on every command is noise to an agent reading output.
  banner: { js: '#!/usr/bin/env node\nprocess.noDeprecation = true;' },
  logLevel: 'info',
});
