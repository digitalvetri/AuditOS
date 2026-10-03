// Bundles the extension into dist/ (load dist/ via chrome://extensions → Load unpacked).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public/manifest.json', 'dist/manifest.json');
cpSync('src/ui/popup/popup.html', 'dist/popup.html');
cpSync('public/icons', 'dist/icons', { recursive: true });

const opts = {
  entryPoints: {
    background: 'src/background/service-worker.ts',
    'crm-bridge': 'src/content/crm-bridge.ts',
    portal: 'src/content/portal-detector.ts',
    popup: 'src/ui/popup/popup.ts',
  },
  outdir: 'dist', bundle: true, format: 'iife', target: 'chrome116', minify: false, sourcemap: false, logLevel: 'info',
};
if (watch) { const ctx = await context(opts); await ctx.watch(); } else { await build(opts); }
