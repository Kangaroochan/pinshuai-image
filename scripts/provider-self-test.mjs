#!/usr/bin/env node
// Loopback-only integration tests: no provider requests or real credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { MODELS, modelSettings, apiBase } from './models.mjs';
import { imageInfo } from './image-files.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const dir=await mkdtemp(path.join(os.tmpdir(),'pinshuai-model-check-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const jpeg=await readFile(new URL('fixtures/two-by-three.jpg',import.meta.url));
const source=path.join(dir,'source.png'), prompt=path.join(dir,'prompt.json');
await writeFile(source,png);
await writeFile(prompt,JSON.stringify({goal:'Recompose this product; preserve count and copy.',subject:{products:[{name:'ornament',count:1}]},constraints:{must_keep:['one ornament','original caption']}}));
let posts=0, gets=0, downloads=0, mode='async', expectedModel='gpt-image-2', pollMode='success', listed=MODELS.map(m=>({id:m.id})), downloadFail=false;
let serverError;
const secret='mock-provider-secret-never-send';
const errors=[];
const server=http.createServer(async(req,res)=>{
  try {
    if(req.url==='/result.png') {
      downloads++;assert.equal(req.headers.authorization,undefined,'Never send API key to image storage');
      if(downloadFail){res.writeHead(503);res.end('download temporarily failed');return;}
      res.setHeader('content-type','image/png');res.end(png);return;
    }
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/models') {gets++;res.end(JSON.stringify({data:listed}));return;}
    if(req.method==='GET') {
      gets++;assert.equal(req.url,'/v1/images/async/edits/task_test_1');
      if(pollMode==='503'){res.writeHead(503);res.end(JSON.stringify({error:'temporary'}));return;}
      const response=pollMode==='pending'?{task_id:'task_test_1',status:'IN_PROGRESS'}:pollMode==='failed'?{task_id:'task_test_1',status:'FAILURE',fail_reason:'provider rejected job'}:pollMode==='weird'?{task_id:'task_test_1',status:'NEW_STATUS'}:{task_id:'task_test_1',status:'SUCCESS',images:[{url:origin+'/result.png'}]};
      res.end(JSON.stringify(response));return;
    }
    posts++;
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    if(mode.startsWith('gemini')) {
      assert.equal(req.url,`/v1beta/models/${expectedModel}:generateContent`);
      const j=JSON.parse(body);
      assert.equal(j.contents.length,1);assert.equal(j.contents[0].role,'user');
      assert.equal(j.contents[0].parts[1].inlineData.mimeType,'image/png');
      assert.deepEqual(Buffer.from(j.contents[0].parts[1].inlineData.data,'base64'),png);
      const effective=JSON.parse(j.contents[0].parts[0].text);
      assert.equal(effective.reconstruction.level,7);assert.equal(effective.subject.products[0].count,1);
      assert.deepEqual(j.generationConfig.responseModalities,['IMAGE']);
      assert.equal(j.generationConfig.imageConfig.imageSize,'2K');
      assert.equal(j.generationConfig.imageConfig.aspectRatio,'1:1');
      assert.equal(j.size,undefined);assert.equal(j.quality,undefined);assert.equal(j.depth,undefined);
      if(mode==='gemini-disconnect') {req.socket.destroy();return;}
      const parts=mode==='gemini-url'?[{text:`![image](${origin}/result.png)`},{fileData:{mimeType:'image/png',fileUri:origin+'/result.png'}}]:mode==='gemini-empty'?[{text:'No image available.'}]:mode==='gemini-multiple'?[{fileData:{fileUri:origin+'/result.png'}},{fileData:{fileUri:origin+'/other.png'}}]:[{inlineData:{mimeType:mode==='gemini-jpeg'?'image/jpeg':'image/png',data:(mode==='gemini-jpeg'?jpeg:png).toString('base64')}}];
      res.end(JSON.stringify({candidates:[{content:{parts}}]}));return;
    }
    assert.equal(req.url,'/v1/images/async/edits');
    assert.ok(body.includes(png));assert.match(body.toString(),/name="image\[\]"/);
    assert.ok(body.toString().includes(`name="model"\r\n\r\n${expectedModel}`));
    const p=JSON.parse(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(body.toString())[1]);
    assert.equal(p.reconstruction.level,7);assert.equal(p.subject.products[0].count,1);
    assert.ok(!body.toString().includes('name="depth"'));assert.ok(!body.toString().includes('name="output_compression"'));
    if(mode==='reject') {res.writeHead(401);res.end(JSON.stringify({error:secret}));return;}
    if(mode==='disconnect') {req.socket.destroy();return;}
    res.end(JSON.stringify(mode==='missing-id'?{status:'SUBMITTED'}:{task_id:'task_test_1',status:'SUBMITTED'}));
  }catch(e){serverError=e;errors.push(e.message);res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const env={...process.env,OPENAI_API_KEY:secret,OPENAI_BASE_URL:origin+'/v1',OPENAI_IMAGE_MODEL:'gpt-image-2',ENABLE_GARDEN_IMAGEGEN:'1',PINSHUAI_CASEBOOK_PATH:path.join(dir,'failure-cases.md')};
const checks=[];
async function cli(args){
  const r=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(here,'run.mjs'),...args],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });if(serverError)throw serverError;return r;
}
const inputs=['--image',source,'--promptfile',prompt];
const fast=['--poll-interval-ms','10','--wait-timeout-ms','35','--request-timeout-ms','1000'];
async function job(name,model,args=[]){expectedModel=model;return cli(['7',...inputs,'--model',model,'--output-dir',path.join(dir,name),...fast,...args]);}
async function journal(name){return JSON.parse(await readFile(path.join(dir,name,'run.json'),'utf8'));}
try {
  assert.equal(apiBase('https://vip.brioi.com'),'https://vip.brioi.com/v1');
  assert.equal(modelSettings({model:'gpt-image-2',base:'https://vip.brioi.com/v1',source:{width:1,height:1}}).transport,'gpt-async');
  checks.push('Brioi origin and /v1 normalize to the async GPT endpoint');
  const before=await readdir(dir), selection=await cli([...inputs,'7']);
  assert.equal(selection.code,2);assert.equal(JSON.parse(selection.stdout).status,'model_selection_required');assert.equal(JSON.parse(selection.stdout).depth,7);assert.equal(posts,0);assert.equal(gets,0);assert.deepEqual(await readdir(dir),before);
  checks.push('missing model asks selection without network/files despite legacy OPENAI_IMAGE_MODEL');
  const offline=await cli(['--list-models','--offline']);assert.equal(JSON.parse(offline.stdout).models.length,5);assert.equal(gets,0);
  const list=await cli(['--list-models']);assert.equal(JSON.parse(list.stdout).models.filter(m=>m.listed).length,5);assert.equal(posts,0);
  checks.push('catalog lists exactly five choices and live GET is free of generation POSTs');
  const invalids=[['--model','nano-banana-pro'],['--model','gemini-3.0-pro-image','--aspect-ratio','4:5'],['--model','gemini-3.1-flash-image','--image-size','2k'],['--model','gemini-3.1-flash-image','--quality','medium'],['--model','gemini-3.1-flash-image','--transport','async'],['--model','gpt-image-2','--size','16x16']];
  const seen=gets;for(const args of invalids){const r=await cli([...inputs,...args,'--dry-run']);assert.notEqual(r.code,0);}
  assert.equal(posts,0);assert.equal(gets,seen);
  checks.push('unsupported models and per-family invalid parameters stop before HTTP');
  listed=[];const unavailable=await job('not-listed','gpt-image-2',['--transport','async']);assert.notEqual(unavailable.code,0);assert.equal(posts,0);
  await assert.rejects(access(path.join(dir,'not-listed')));listed=MODELS.map(m=>({id:m.id}));
  checks.push('unlisted model never POSTs or creates a task directory');
  mode='async';pollMode='success';
  for(const model of MODELS.filter(m=>m.family==='gpt')){
    const n=model.id;const r=await job(n,model.id,['--transport','async']);assert.equal(r.code,0,r.stderr);const s=await journal(n);assert.equal(s.task_id,'task_test_1');assert.equal(s.request_count,1);assert.equal(s.depth,7);assert.equal(s.output.width,1);
    const count=posts;const resumed=await cli(['--resume',path.join(dir,n)]);assert.equal(resumed.code,0);assert.equal(posts,count);assert.equal(JSON.parse(resumed.stdout).posted_again,false);
  }
  checks.push('all three GPT IDs carry original bytes, depth and locks through async task save/query/download');
  pollMode='503';const pending=await job('pending','gpt-image-2',['--transport','async']);assert.equal(pending.code,2);assert.equal((await journal('pending')).task_id,'task_test_1');
  const postsBefore=posts;pollMode='success';const resumed=await cli(['--resume',path.join(dir,'pending')]);assert.equal(resumed.code,0);assert.equal(posts,postsBefore);assert.equal((await journal('pending')).status,'completed');
  checks.push('polling 503 preserves task ID; resume finishes with GET only');
  pollMode='weird';const weird=await job('weird','gpt-image-2',['--transport','async']);assert.equal(weird.code,2);assert.equal((await journal('weird')).provider_status,'NEW_STATUS');
  checks.push('unrecognized provider status stays unfinished rather than false success');
  pollMode='failed';const failed=await job('failed','gpt-image-2',['--transport','async']);assert.equal((await journal('failed')).status,'failed');assert.notEqual(failed.code,0);pollMode='success';
  checks.push('explicit provider failure is terminal');
  mode='disconnect';const disconnected=await job('disconnected','gpt-image-2',['--transport','async']);assert.equal((await journal('disconnected')).status,'unknown');const p1=posts,g1=gets;await cli(['--resume',path.join(dir,'disconnected')]);assert.equal(posts,p1);assert.equal(gets,g1);
  mode='missing-id';await job('missing-id','gpt-image-2',['--transport','async']);assert.equal((await journal('missing-id')).status,'unknown');const p2=posts;await cli(['--resume',path.join(dir,'missing-id')]);assert.equal(posts,p2);
  checks.push('uncertain submission or missing task ID never automatically resubmits');
  mode='reject';const reject=await job('rejected','gpt-image-2',['--transport','async']);assert.equal((await journal('rejected')).status,'rejected');assert.ok(!reject.stdout.includes(secret));assert.ok(!(await readFile(path.join(dir,'rejected','stderr.log'),'utf8')).includes(secret));
  checks.push('authentication errors stay rejected and secrets are redacted');
  for(const model of MODELS.filter(m=>m.family==='gemini')){
    mode='gemini-inline';const r=await job(model.id,model.id,['--image-size','2K']);assert.equal(r.code,0,r.stderr);const s=await journal(model.id);assert.equal(s.transport,'gemini-sync');assert.equal(s.output.mime_type,'image/png');assert.equal(s.task_id,undefined);
  }
  checks.push('both Gemini IDs use native contents, exact base64 bytes and family-specific parameters');
  assert.equal(imageInfo(jpeg).width,2);assert.equal(imageInfo(jpeg).height,3);
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');assert.equal(imageInfo(webp).mime_type,'image/webp');assert.equal(imageInfo(webp).width,1);
  mode='gemini-jpeg';const jr=await job('gemini-jpeg','gemini-3.1-flash-image',['--image-size','2K']);assert.equal(jr.code,0);const js=await journal('gemini-jpeg');assert.ok(js.output.path.endsWith('.jpg'));assert.equal(js.output.width,2);assert.equal(js.output.height,3);assert.deepEqual(await readFile(js.output.path),jpeg);
  const jp=posts;await cli(['--resume',path.join(dir,'gemini-jpeg')]);assert.equal(posts,jp);
  checks.push('actual JPEG bytes use .jpg with correct dimensions; JPEG resume and WebP format detection work');
  mode='gemini-url';downloadFail=true;await job('gemini-download','gemini-3.1-flash-image',['--image-size','2K']);assert.equal((await journal('gemini-download')).status,'unknown');
  const p3=posts,d3=downloads;downloadFail=false;const downloadResume=await cli(['--resume',path.join(dir,'gemini-download')]);assert.equal(downloadResume.code,0);assert.equal(posts,p3);assert.equal(downloads,d3+1);
  checks.push('Gemini fileData/Markdown duplicate URLs count once; failed download resumes from saved response without POST');
  for(const m of ['gemini-multiple','gemini-empty','gemini-disconnect']){
    mode=m;const r=await job(m,'gemini-3.1-flash-image',['--image-size','2K']);assert.notEqual(r.code,0);assert.equal((await journal(m)).status,'unknown');const p4=posts;await cli(['--resume',path.join(dir,m)]);assert.equal(posts,p4);
  }
  checks.push('Gemini empty/multiple/uncertain responses preserve evidence and never retry generation');
  const duplicate=await job('gpt-image-2','gpt-image-2',['--transport','async']);assert.notEqual(duplicate.code,0);assert.match(duplicate.stderr,/already exists/);
  checks.push('existing output directory refuses overwrite before model lookup or POST');
  console.log(JSON.stringify({passed:true,checks,checks_passed:checks.length,mock_posts:posts,mock_gets:gets,provider_requests:0,fixture_directory:dir},null,2));
} finally {await new Promise(resolve=>server.close(resolve));}
