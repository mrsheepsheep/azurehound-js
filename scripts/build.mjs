import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const output = 'collector.js';
await build({
  entryPoints: ['src/main.ts'],
  outfile: output,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome100', 'firefox100'],
  legalComments: 'none',
  banner: { js: '/* AzureHound browser collector. GPL-3.0-or-later; see ../AzureHound/LICENSE.md. Build with npm run build. */' }
});
// Keep eval(collectorSource) awaitable, as with the original single-file collector.
await writeFile(output, `${await readFile(output, 'utf8')}\nwindow.AzureHound.completion;\n`);
