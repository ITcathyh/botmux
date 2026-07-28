#!/usr/bin/env node
/**
 * Package the botmux worker runtime as a standalone `@botmux/worker` npm package
 * for embedding in a riff sandbox (topology B, codex/PTY webshell).
 *
 * WHY a package (not an esbuild single-file bundle): worker.js resolves sibling
 * files (codex-app-runner.js, cli.js, data/) and node-pty via
 * `import.meta.url` / `createRequire(import.meta.url)`. A single-file bundle
 * breaks those. Shipping the whole compiled `dist/` tree preserves every path
 * relationship exactly as a normal install — which is what we verified running
 * `dist/worker.js` directly.
 *
 * Native deps resolved WITHOUT a build toolchain:
 *  - node-pty  → aliased to @homebridge/node-pty-prebuilt-multiarch (prebuilt
 *                .node for linux-x64/arm64, glibc+musl; drop-in `spawn` API).
 *  - @napi-rs/canvas → linux prebuilt npm packages (screenshot rendering; not on
 *                the webshell path but eagerly imported, so kept as a dep).
 *
 * Output: a staging dir with dist/ + a generated package.json. Run `npm publish
 * --tag <pre>` from there. Version + tag are passed in so we never touch the
 * main package.json and never publish to `latest` by accident.
 *
 * Usage: node scripts/package-worker.mjs <version> [outDir]
 *   e.g. node scripts/package-worker.mjs 0.0.1-webshell.0 /tmp/botmux-worker-pkg
 */
import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
const outDir = process.argv[3] ? resolve(process.argv[3]) : join(repoRoot, '.worker-pkg');

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/package-worker.mjs <semver> [outDir]');
  console.error('  version must be semver, e.g. 0.0.1-webshell.0 (use a prerelease tag)');
  process.exit(1);
}

const distSrc = join(repoRoot, 'dist');
if (!existsSync(join(distSrc, 'worker.js'))) {
  console.error(`dist/worker.js not found — run \`pnpm build\` first (looked in ${distSrc})`);
  process.exit(1);
}

// Read the real dep versions so the worker package pins what the build used.
const rootPkg = JSON.parse((await import('node:fs')).readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const rootDeps = rootPkg.dependencies ?? {};

// The worker ships the WHOLE compiled dist/ tree (to preserve import.meta.url
// sibling lookups), and worker.js's static import chain reaches most runtime
// deps (e.g. @modelcontextprotocol/sdk via core/plugins/mcp/host.js). Node
// resolves every static import eagerly, so we must declare the full runtime dep
// set — NOT just node-pty/canvas. Only the truly daemon/desktop-only deps that
// worker.js never imports are excluded to keep the sandbox install lean.
const EXCLUDE = new Set([
  'electron', // desktop app only
  'pm2',      // process manager, daemon-launch only
]);
const deps = {};
for (const [name, ver] of Object.entries(rootDeps)) {
  if (EXCLUDE.has(name)) continue;
  deps[name] = ver;
}
// Override node-pty → prebuilt-multiarch so the sandbox needs no build toolchain.
deps['node-pty'] = 'npm:@homebridge/node-pty-prebuilt-multiarch@^0.14.1';

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// Ship the whole compiled tree under dist/ so import.meta.url sibling lookups work.
cpSync(distSrc, join(outDir, 'dist'), { recursive: true });

const workerPkg = {
  name: '@botmux/worker',
  version,
  private: false,
  description: 'Headless botmux worker runtime for embedding a CLI runner in a sandbox (topology B). Fork dist/worker.js and drive it over IPC.',
  type: 'module',
  // Entry points at the worker; RIFF_WORKER_PATH should point at this file.
  main: 'dist/worker.js',
  exports: { '.': './dist/worker.js', './worker.js': './dist/worker.js' },
  files: ['dist/'],
  engines: { node: '>=20' },
  dependencies: deps,
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
};
writeFileSync(join(outDir, 'package.json'), JSON.stringify(workerPkg, null, 2) + '\n', 'utf8');

// A short README so the package self-documents (and to satisfy npm).
writeFileSync(join(outDir, 'README.md'),
  `# @botmux/worker\n\nHeadless botmux worker runtime for topology B (embed a CLI runner in a sandbox).\n\n` +
  `Fork \`dist/worker.js\` (via node:child_process.fork with an IPC channel) and drive it with an\n` +
  `\`init\` message; point \`RIFF_WORKER_PATH\` at it from riff-cli-runner. node-pty ships prebuilt\n` +
  `(no build toolchain). This is a prerelease-tagged internal artifact — not for \`latest\`.\n`,
  'utf8');

console.log(`Staged @botmux/worker@${version} at:\n  ${outDir}`);
console.log(`\nNext (only when explicitly asked to publish):`);
console.log(`  cd ${outDir} && npm publish --tag webshell   # prerelease tag, never latest`);
