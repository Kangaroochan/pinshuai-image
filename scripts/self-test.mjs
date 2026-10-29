#!/usr/bin/env node
// Offline integration checks. Only a loopback mock API is used, never a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { MODELS } from './models.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'pinshuai-image-check-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const source = path.join(dir, 'reference.png'), prompt = path.join(dir, 'prompt.json');
await writeFile(source, png);
await writeFile(prompt, JSON.stringify({
  goal:'Re-stage a product in daylight; preserve its original shape and count.',
  target_market:'European and North American customers; default new copy to natural English.',
  marketing_concepts:[{creative_origin:'Unverified listing copy: rain-ready organization',evidence_status:'unverified_creative',concept:'A calmer start to a rainy day',claim_boundary:'Scene mood only; do not claim waterproofing or show water resistance as proven'}],
  subject:{products:[{name:'round ornament',count:1}]},
  human_presence:{enabled:true,planned_appearance_changes:['distinct fictional face'],batch_person_allocation:{planned_counts:'15 women, 5 men; 14 light, 3 medium-brown, 3 dark across 10 two-person outputs',per_output_cast_profiles:[{output:1,people:[{face:'oval face, wide-set eyes, straight brows, narrow nose'}]}]}},
  constraints:{must_keep:['one original round ornament'],must_change:['scene and lighting']}
}));
const secret = 'mock-key-never-contact-a-provider';
let count = 0, mode = 'ok', expectedDepth = 8;
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:MODELS.map(m=>({id:m.id}))})); return; }
  count++;
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  assert.equal(req.url, '/v1/images/edits');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  assert.ok(body.includes(png), 'Actual source bytes must be attached.');
  assert.match(body.toString('utf8'), /name="n"\r\n\r\n1/);
  assert.match(body.toString('utf8'), /name="model"\r\n\r\ngpt-image-2/);
  assert.ok(!body.toString('utf8').includes('name="output_compression"'), 'PNG edits must not send an implicit compression value.');
  assert.ok(!body.toString('utf8').includes('name="moderation"'), 'Do not send an invalid implicit moderation value.');
  const submitted = JSON.parse(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(body.toString('utf8'))[1]);
  assert.equal(submitted.reconstruction.level, expectedDepth);
  assert.match(submitted.reconstruction.invariants, /product identity, count/);
  assert.match(submitted.reconstruction.priority, /Explicit user locks/);
  assert.equal(submitted.subject.products[0].count, 1);
  assert.match(submitted.target_market,/European and North American customers/);
  assert.equal(submitted.marketing_concepts[0].evidence_status,'unverified_creative');
  assert.match(submitted.marketing_concepts[0].creative_origin,/Unverified listing copy/);
  assert.match(submitted.marketing_concepts[0].claim_boundary,/do not claim waterproofing/);
  assert.equal(typeof submitted.reconstruction.human_expression.depth_guidance, 'string');
  assert.match(submitted.reconstruction.human_expression.emotional_tone_rule, /Change emotional direction only when the user explicitly requests it/);
  assert.match(submitted.reconstruction.human_expression.priority, /Identity preservation alone does not freeze expression/);
  assert.equal(typeof submitted.reconstruction.human_appearance.depth_guidance, 'string');
  assert.match(submitted.reconstruction.human_appearance.casting_rule, /do not depict Asian faces/);
  assert.match(submitted.reconstruction.human_appearance.casting_rule, /An explicit user task prompt requesting Asian casting/);
  assert.match(submitted.reconstruction.human_appearance.casting_rule, /only for the specified people/);
  assert.match(submitted.reconstruction.human_appearance.casting_rule, /low-depth face-retention guidance/);
  assert.equal(submitted.reconstruction.human_appearance.minimum_face_identity_changes, expectedDepth <= 4 ? 0 : expectedDepth <= 6 ? 3 : 4);
  assert.match(submitted.reconstruction.human_appearance.planning, /different cast profile/);
  assert.deepEqual(submitted.reconstruction.human_appearance.batch_cast_plan, submitted.human_presence.batch_person_allocation);
  if(expectedDepth >= 7) assert.match(submitted.reconstruction.human_appearance.depth_guidance, /at least four changed identity-bearing facial features/);
  assert.match(submitted.reconstruction.human_appearance.scope, /user-locked people/);
  assert.match(submitted.reconstruction.human_appearance.applicable_only, /No new people/);
  assert.ok(!body.toString('utf8').includes('name="depth"'), 'Depth is not an API parameter.');
  if (mode === 'disconnect') { req.socket.destroy(); return; }
  res.setHeader('content-type', 'application/json');
  if (mode === 'reject') { res.writeHead(401); res.end(JSON.stringify({error:`mock authentication failure ${secret}`})); return; }
  const data = [{b64_json:png.toString('base64')}];
  if (mode === 'multiple') data.push(data[0]);
  res.end(JSON.stringify({data}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = {...process.env, OPENAI_API_KEY:secret, OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`, OPENAI_IMAGE_MODEL:'gpt-image-2', ENABLE_GARDEN_IMAGEGEN:'1', PINSHUAI_CASEBOOK_PATH:path.join(dir,'failure-cases.md')};
const checks = [];
async function existsForTest(file) { try { await readFile(file); return true; } catch { return false; } }
async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here,'run.mjs'),...args], {cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data', b => stdout += b.toString('utf8'));
    child.stderr.on('data', b => stderr += b.toString('utf8'));
    child.once('error',reject);
    child.once('close',code => resolve({code,stdout,stderr}));
  });
}
const base = ['--image',source,'--promptfile',prompt,'--model','gpt-image-2'];
try {
  const dry = await cli([...base,'--dry-run']);
  assert.equal(dry.code,0); assert.equal(count,0); assert.equal(JSON.parse(dry.stdout).requests_sent,0);
  assert.deepEqual((await readdir(dir)).sort(),['prompt.json','reference.png']);
  checks.push('dry-run makes no requests or task files');
  assert.equal(JSON.parse(dry.stdout).depth,5);
  const shorthand = await cli(['7',...base,'--dry-run']);
  assert.equal(shorthand.code,0,shorthand.stderr);
  assert.equal(JSON.parse(shorthand.stdout).depth,7);
  assert.equal(JSON.parse(shorthand.stdout).n,1);
  const trailing = await cli([...base,'10','--dry-run']);
  assert.equal(trailing.code,0,trailing.stderr);
  assert.equal(JSON.parse(trailing.stdout).depth,10);
  for(const args of [['7','--depth','8'],['--depth','7','8'],['11'],['0']]) {
    const rejectedDepth = await cli([...base,...args,'--dry-run']);
    assert.notEqual(rejectedDepth.code,0);
  }
  assert.equal(count,0);
  checks.push('bare number selects depth without changing output count; duplicates and range errors blocked');
  const scopes = new Set(), expressions = new Set();
  for (let level=1; level<=10; level++) {
    const result = await cli([...base,'--depth',String(level),'--dry-run']);
    assert.equal(result.code,0,result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.depth,level); assert.equal(parsed.reconstruction.level,level);
    scopes.add(parsed.reconstruction.scope);
    expressions.add(parsed.reconstruction.human_expression.depth_guidance);
    assert.match(parsed.reconstruction.human_expression.depth_guidance, /Keep the source emotional tone/);
    assert.match(parsed.reconstruction.human_expression.emotional_tone_rule, /including 10/);
    assert.match(parsed.reconstruction.human_appearance.casting_rule, /do not depict Asian faces/);
    if (level <= 4) assert.match(parsed.reconstruction.human_appearance.depth_guidance, /casting rule/);
  }
  assert.equal(expressions.size,10);
  assert.equal(scopes.size,10); assert.equal(count,0);
  checks.push('all ten integer depths yield distinct prompt guidance; default is five');
  checks.push('default casting rule reaches every depth and the submitted image prompt');
  for(const level of ['0','11','1.5','01','abc']) {
    const invalid = await cli([...base,'--depth',level,'--dry-run']);
    assert.notEqual(invalid.code,0); assert.equal(count,0);
  }
  checks.push('out-of-range, fractional, malformed depths rejected before HTTP');
  const declaredPrompt = path.join(dir,'declared.json');
  const declared = JSON.parse(await readFile(prompt,'utf8'));
  declared.reconstruction = {level:3,locked_dimensions:['camera viewpoint']};
  await writeFile(declaredPrompt,JSON.stringify(declared));
  const fromFile = await cli(['--image',source,'--promptfile',declaredPrompt,'--model','gpt-image-2','--dry-run']);
  assert.equal(fromFile.code,0);
  assert.equal(JSON.parse(fromFile.stdout).depth,3);
  assert.deepEqual(JSON.parse(fromFile.stdout).reconstruction.locked_dimensions,['camera viewpoint']);
  const conflict = await cli(['--image',source,'--promptfile',declaredPrompt,'--model','gpt-image-2','--depth','8','--dry-run']);
  assert.notEqual(conflict.code,0); assert.equal(count,0);
  checks.push('prompt depth and locks retained; conflicting CLI depth blocked');
  const okDir = path.join(dir,'success');
  const ok = await cli([...base,'--depth','8','--output-dir',okDir]);
  assert.equal(ok.code,0,ok.stderr); assert.equal(count,1);
  const resultPath = JSON.parse(ok.stdout).output.path;
  assert.deepEqual(await readFile(resultPath),png);
  assert.equal(path.dirname(path.dirname(resultPath)),path.dirname(source));
  assert.match(path.basename(path.dirname(resultPath)),/^\d{4}-\d{4}(?:-\d{2,})?$/);
  assert.deepEqual(await readdir(path.dirname(resultPath)),[path.basename(resultPath)]);
  assert.deepEqual(await readFile(path.join(okDir,'reference.png')),png);
  assert.equal(await existsForTest(path.join(okDir,'result.png')),false);
  const state = JSON.parse(await readFile(path.join(okDir,'run.json'),'utf8'));
  assert.equal(state.status,'completed'); assert.equal(state.output.width,1); assert.equal(state.visual_review,'not_reviewed');
  assert.equal(state.depth,8);
  const savedPrompt = JSON.parse(await readFile(path.join(okDir,'prompt.json'),'utf8'));
  assert.equal(savedPrompt.reconstruction.level,8);
  assert.deepEqual(savedPrompt.subject,JSON.parse(await readFile(prompt,'utf8')).subject);
  assert.deepEqual(await readFile(path.join(okDir,'prompt-input.json')),Buffer.concat([await readFile(prompt),Buffer.from('\n')]));
  checks.push('original bytes reach edit endpoint; result, input, parameters and hashes saved');
  checks.push('selected depth reaches actual edit prompt and journal without changing product inventory');
  const beforeResume=await readdir(path.dirname(source));
  const resume = await cli(['--resume',okDir]);
  assert.equal(resume.code,0); assert.equal(count,1); assert.equal(JSON.parse(resume.stdout).posted_again,false);
  assert.equal(JSON.parse(resume.stdout).output.path,resultPath);
  assert.deepEqual(await readdir(path.dirname(source)),beforeResume);
  checks.push('resume verifies the external image without reposting or creating an extra image folder');
  const collision = await cli([...base,'--output-dir',okDir]);
  assert.notEqual(collision.code,0); assert.equal(count,1);
  checks.push('existing task directory refuses overwrite and duplicate submission');
  expectedDepth=5;
  mode='reject';
  const rejected = await cli([...base,'--output-dir',path.join(dir,'rejected')]);
  assert.equal(count,2); assert.notEqual(rejected.code,0);
  assert.equal(JSON.parse(rejected.stdout).status,'rejected');
  assert.ok(!rejected.stdout.includes(secret));
  assert.ok(!(await readFile(path.join(dir,'rejected','stderr.log'),'utf8')).includes(secret));
  const casebook = await readFile(env.PINSHUAI_CASEBOOK_PATH,'utf8');
  assert.match(casebook,/"category": "provider_rejected"/);
  assert.match(casebook,/"confidence": "confirmed"/);
  assert.ok(!casebook.includes(secret));
  assert.ok(!casebook.includes(dir));
  checks.push('401 preserved as rejection, no retry, error log masks key');
  mode='disconnect';
  const unknown = await cli([...base,'--output-dir',path.join(dir,'unknown')]);
  assert.equal(count,3); assert.notEqual(unknown.code,0); assert.equal(JSON.parse(unknown.stdout).status,'unknown');
  const uncertainResume = await cli(['--resume',path.join(dir,'unknown')]);
  assert.equal(uncertainResume.code,2); assert.equal(count,3); assert.equal(JSON.parse(uncertainResume.stdout).status,'unknown');
  checks.push('uncertain network failure remains unknown; resume never creates another request');
  mode='multiple';
  const multiple = await cli([...base,'--output-dir',path.join(dir,'multiple')]);
  assert.equal(count,4); assert.notEqual(multiple.code,0); assert.equal(JSON.parse(multiple.stdout).status,'unknown');
  checks.push('unexpected multiple outputs are not silently truncated');
  const empty=path.join(dir,'empty.json'); await writeFile(empty,JSON.stringify({goal:'',subject:{products:[]},constraints:{}}));
  const invalid=await cli(['--image',source,'--promptfile',empty,'--dry-run']);
  assert.notEqual(invalid.code,0); assert.equal(count,4);
  checks.push('unfilled prompt rejected before HTTP');
  mode='ok';
  const defaultOutput = await cli(base);
  assert.equal(defaultOutput.code,0,defaultOutput.stderr);
  const defaultState = JSON.parse(defaultOutput.stdout);
  const defaultDir = path.dirname(defaultState.output.path);
  assert.equal(path.dirname(path.dirname(defaultState.prompt.path)),path.join(dir,'output','pinshuai-image'));
  assert.equal(defaultState.run_dir,path.dirname(defaultState.prompt.path));
  assert.equal(path.dirname(defaultDir),path.dirname(source));
  assert.match(path.basename(defaultDir),/^\d{4}-\d{4}(?:-\d{2,})?$/);
  assert.deepEqual(await readdir(defaultDir),[path.basename(defaultState.output.path)]);
  assert.ok(await existsForTest(path.join(path.dirname(defaultState.prompt.path),'run.json')));
  assert.equal(await existsForTest(path.join(path.dirname(defaultState.prompt.path),'result.png')),false);
  const defaultOutputAgain = await cli(base);
  assert.equal(defaultOutputAgain.code,0,defaultOutputAgain.stderr);
  const secondDefaultDir = path.dirname(JSON.parse(defaultOutputAgain.stdout).output.path);
  assert.notEqual(secondDefaultDir,defaultDir);
  assert.equal(path.dirname(secondDefaultDir),path.dirname(source));
  assert.deepEqual(await readdir(secondDefaultDir),[path.basename(JSON.parse(defaultOutputAgain.stdout).output.path)]);
  checks.push('only generated images go into timestamped sibling folders; task artifacts stay in the default run directory and collisions get unique suffixes');
  const explicitPrompt = path.join(dir,'explicit-casting.json');
  const explicitInput = JSON.parse(await readFile(prompt,'utf8'));
  explicitInput.goal = 'The user explicitly requests one Asian adult in this scene.';
  await writeFile(explicitPrompt,JSON.stringify(explicitInput));
  const explicitRun = await cli(['--image',source,'--promptfile',explicitPrompt,'--model','gpt-image-2','--output-dir',path.join(dir,'explicit-casting')]);
  assert.equal(explicitRun.code,0,explicitRun.stderr);
  const explicitSaved = JSON.parse(await readFile(path.join(dir,'explicit-casting','prompt.json'),'utf8'));
  assert.equal(explicitSaved.goal,explicitInput.goal);
  assert.match(explicitSaved.reconstruction.human_appearance.casting_rule, /only for the specified people/);
  checks.push('explicit user casting request remains in the submitted prompt as a scoped exception');
  const shared=path.join(dir,'one-group');
  const otherParent=path.join(dir,'other-references');
  await mkdir(otherParent);
  const otherSource=path.join(otherParent,'reference.png');
  await writeFile(otherSource,png);
  const grouped=await Promise.all([source,otherSource].map((image,index)=>cli(['--image',image,'--promptfile',prompt,'--model','gpt-image-2','--result-dir',shared,'--result-name','01','--output-dir',path.join(dir,`group-task-${index}`)])));
  grouped.forEach(result=>assert.equal(result.code,0,result.stderr));
  const outputs=grouped.map(result=>JSON.parse(result.stdout));
  assert.deepEqual((await readdir(shared)).sort(),['01-02.png','01.png']);
  assert(outputs.every(state=>path.dirname(state.output.path)===shared));
  assert.equal(new Set(outputs.map(state=>state.output.path)).size,2);
  assert.deepEqual(await readdir(otherParent),['reference.png']);
  const groupPosts=count;
  const recovered=await cli(['--resume',outputs[0].run_dir]);
  assert.equal(recovered.code,0,recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).output.path,outputs[0].output.path);
  assert.equal(count,groupPosts);
  assert.deepEqual((await readdir(shared)).sort(),['01-02.png','01.png']);
  checks.push('one group shares a single image-only folder across source directories, concurrent name collisions never overwrite, and resume reuses the saved path without POST');
  console.log(JSON.stringify({passed:true,checks,checks_passed:checks.length,mock_requests:count,provider_requests:0,fixture_directory:dir},null,2));
} finally { await new Promise(resolve => server.close(resolve)); }
