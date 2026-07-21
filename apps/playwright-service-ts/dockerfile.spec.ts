import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PLAYWRIGHT_IMAGE =
  'mcr.microsoft.com/playwright:v1.58.1-noble@sha256:feae0b1581609d3dc2ba22567b4703dd6a3e7a219984bb86a19ed35007148a91';

test('pins Docker dependency resolution to the tracked lockfile', async () => {
  const [dockerfile, manifestText, lockfile] = await Promise.all([
    readFile(new URL('./Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('./package.json', import.meta.url), 'utf8'),
    readFile(new URL('./pnpm-lock.yaml', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as {
    packageManager?: string;
    dependencies?: Record<string, string>;
  };

  assert.equal(manifest.packageManager, 'pnpm@10.33.0');
  assert.equal(manifest.dependencies?.playwright, '1.58.1');
  assert.match(
    lockfile,
    /playwright:\n\s+specifier: 1\.58\.1\n\s+version: 1\.58\.1/,
  );
  assert.match(
    dockerfile,
    new RegExp(`^FROM ${PLAYWRIGHT_IMAGE} AS runtime$`, 'm'),
  );
  assert.match(dockerfile, /^RUN corepack enable$/m);
  assert.match(
    dockerfile,
    /^RUN corepack prepare pnpm@10\.33\.0 --activate$/m,
  );
  assert.doesNotMatch(dockerfile, /^RUN\s+.*\b(?:npm|npx)\b.*$/m);
  assert.deepEqual(
    dockerfile.match(/^RUN\s+(?:pnpm|npm|yarn|npx)\b.*\b(?:install|ci)\b.*$/gm),
    ['RUN pnpm install --frozen-lockfile'],
  );

  const dependencyCopy = dockerfile.indexOf(
    'COPY package.json pnpm-lock.yaml ./',
  );
  const frozenInstall = dockerfile.indexOf(
    'RUN pnpm install --frozen-lockfile',
  );
  const sourceCopy = dockerfile.indexOf('COPY . .');
  assert.ok(dependencyCopy >= 0);
  assert.ok(frozenInstall > dependencyCopy);
  assert.ok(sourceCopy > frozenInstall);
});
