#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordRuntimeFailure, recordVisualReview } from './casebook.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'pinshuai-casebook-test-'));
const book = path.join(dir, 'failure-cases.md');
process.env.PINSHUAI_CASEBOOK_PATH = book;

const runtime = {status:'rejected',http_status:401,error:'Bearer api-secret-never-store',model:'gpt-image-2',depth:8,prompt:{sha256:'a'.repeat(64)},source:{sha256:'b'.repeat(64)}};
const logged = await recordRuntimeFailure(path.join(dir,'run-one'),runtime);
assert.equal(logged.recorded,true);
const repeatedLog = await recordRuntimeFailure(path.join(dir,'run-one'),runtime);
assert.equal(repeatedLog.duplicate,true);
let contents = await readFile(book,'utf8');
assert.ok(!contents.includes('api-secret-never-store'));
assert.ok(!contents.includes(dir));
assert.match(contents,/provider_rejected/);

await assert.rejects(recordVisualReview(path.join(dir,'run-two'),{visual_review:'not_reviewed',checks:{product_identity:'fail'}}));
await recordVisualReview(path.join(dir,'run-two'),{
  visual_review:'reviewed',
  visual_pass:false,
  checks:{product_identity:'fail',copy:'pass'},
  issues:['A product detail is missing; inspect [LOCAL_PATH] result.'],
  successful_decisions:['Keep the source advertising copy unchanged.'],
});
await recordVisualReview(path.join(dir,'run-three'),{
  visual_review:'reviewed',
  visual_pass:false,
  checks:{product_identity:'fail'},
  issues:['A product detail is missing.'],
});

contents = await readFile(book,'utf8');
assert.equal((contents.match(/"kind": "visual_review"/g)||[]).length,2);
const lessons = spawnSync(process.execPath,[path.join(here,'casebook.mjs'),'lessons','--category','product_identity'],{
  cwd:dir,encoding:'utf8',env:process.env,
});
assert.equal(lessons.status,0,lessons.stderr);
const result=JSON.parse(lessons.stdout);
assert.equal(result.recurring_candidates.length,1);
assert.equal(result.recurring_candidates[0].category,'product_identity');
assert.equal(result.recurring_candidates[0].state,'candidate_rule_requires_review');
console.log(JSON.stringify({passed:true,checks:5,provider_requests:0,casebook:book},null,2));
