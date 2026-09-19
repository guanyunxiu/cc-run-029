// 用 esbuild 把测试入口打包为 ESM，再在 Node 中执行
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const entry = 'test/index.ts';
const outfile = 'test/.build/index.mjs';

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

const mod = await import(pathToFileURL(process.cwd() + '/' + outfile).href + '?t=' + Date.now());
const code = await mod.run();
rmSync('test/.build', { recursive: true, force: true });
process.exit(code);
