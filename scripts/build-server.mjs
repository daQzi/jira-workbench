import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const common = { bundle: true, platform: 'node', target: 'node26', format: 'esm', logLevel: 'warning' };
await mkdir('.wb-build', { recursive: true });
await build({ ...common, entryPoints: ['server/domain-entry.ts'], outfile: '.wb-build/domain.mjs' });
if (process.argv[2]) {
  const dest = path.resolve(process.argv[2]);
  await mkdir(dest, { recursive: true });
  for (const entry of ['index', 'mcp-stdio']) {
    await build({ ...common, entryPoints: [`server/${entry}.mjs`], outfile: path.join(dest, `${entry}.mjs`),
      banner: { js: "import { createRequire as __wbCreateRequire } from 'node:module'; const require = __wbCreateRequire(import.meta.url);" } });
  }
}
