#!/usr/bin/env node
// Local configuration tests only. No network calls and no real credentials.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fillMissing, localConfig, ignoredEnv, saveConfiguration } from './setup-provider.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'pinshuai-setup-test-'));
const checks = [];
const script = fileURLToPath(new URL('setup-provider.mjs', import.meta.url));
try {
  const before = '# keep comment\r\nUNCHANGED=value\r\nOPENAI_API_KEY=""\r\nOPENAI_BASE_URL=https://example.com/v1\r\n';
  const fake = 'mock-setup-value-$dollar\\backslash';
  const next = fillMissing(before, {
    ENABLE_GARDEN_IMAGEGEN: '1',
    OPENAI_BASE_URL: 'https://different.invalid/v1',
    OPENAI_API_KEY: fake
  });
  assert.equal(localConfig(next).OPENAI_API_KEY, fake);
  assert.equal(localConfig(next).OPENAI_BASE_URL, 'https://example.com/v1');
  assert.ok(next.startsWith('# keep comment\r\nUNCHANGED=value\r\n'));
  assert.ok(!next.includes('\nOPENAI_API_KEY="mock-setup-value-$dollar\\\\backslash"'));
  assert.equal(fillMissing(next, { OPENAI_API_KEY: 'do-not-overwrite' }), next);
  checks.push('empty entries are filled; comments, line endings, existing values and special characters survive');

  assert.throws(() => fillMissing('', { OPENAI_API_KEY: 'value\nINJECT=1' }));
  assert.throws(() => localConfig('OPENAI_API_KEY=first\nOPENAI_API_KEY=second\n'));
  checks.push('multiline injection and ambiguous duplicate fields are rejected');

  await saveConfiguration(directory, null, {
    ENABLE_GARDEN_IMAGEGEN: '1',
    OPENAI_BASE_URL: 'https://example.com/v1',
    OPENAI_API_KEY: fake
  });
  const saved = await readFile(path.join(directory, '.env'), 'utf8');
  assert.equal(localConfig(saved).OPENAI_API_KEY, fake);
  const ignore = await readFile(path.join(directory, '.gitignore'), 'utf8');
  assert.ok(ignore.split('\n').includes('.env'));
  assert.ok(ignore.split('\n').includes('.env.*'));
  assert.ok(ignore.split('\n').includes('!.env.example'));
  assert.equal(ignoredEnv(ignore), ignore);
  await saveConfiguration(directory, saved, { OPENAI_API_KEY: 'replacement' });
  assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), saved);
  checks.push('local file writes protect .env in gitignore and preserve configured values');

  await writeFile(path.join(directory, '.env'), saved + 'CONCURRENT_EDIT=keep\n');
  await assert.rejects(saveConfiguration(directory, saved, { OPENAI_API_KEY: 'replacement' }));
  assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), saved + 'CONCURRENT_EDIT=keep\n');
  checks.push('changed snapshots refuse to overwrite concurrent edits');

  const environment = {
    ...process.env,
    ENABLE_GARDEN_IMAGEGEN: '1',
    OPENAI_BASE_URL: 'https://example.com/v1',
    OPENAI_API_KEY: fake
  };
  const listing = await readdir(directory);
  const status = spawnSync(process.execPath, [script, '--status'], { cwd: directory, env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).config.OPENAI_API_KEY, 'SET');
  assert.equal(JSON.parse(status.stdout).network_requests, 0);
  assert.ok(!status.stdout.includes(fake));
  const complete = spawnSync(process.execPath, [script], { cwd: directory, env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(complete.status, 0);
  assert.ok(!complete.stdout.includes(fake));
  assert.deepEqual(await readdir(directory), listing);
  checks.push('status and existing configuration return no credentials and create no new config');

  const disabled = spawnSync(process.execPath, [script], { cwd: directory, env: { ...environment, ENABLE_GARDEN_IMAGEGEN: '0' }, encoding: 'utf8', windowsHide: true });
  assert.equal(disabled.status, 1);
  assert.ok(!disabled.stdout.includes(fake));
  const badArgument = spawnSync(process.execPath, [script, '--key', fake], { cwd: directory, env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(badArgument.status, 1);
  assert.ok(!badArgument.stdout.includes(fake));
  checks.push('disabled API is not reported ready; secret command-line arguments are rejected without echo');
  console.log(JSON.stringify({ passed: true, checks_passed: checks.length, checks, provider_requests: 0 }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
