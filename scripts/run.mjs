#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadAmbientEnv } from './shared.js';
import { applyReconstruction } from './reconstruction.mjs';
import { MODELS, modelInfo, modelSettings, availableModels, apiBase } from './models.mjs';
import { imageInfo } from './image-files.mjs';
import { submit, poll, resultBytes, HttpError } from './provider.mjs';
import { recordRuntimeFailure } from './casebook.mjs';

const help = `Pinshuai Image: one original reference -> one edited image.
node scripts/run.mjs [1-10] --image <source> --promptfile <filled.json> --model <id>
  --list-models          Read current API key's model list; never generates
  --offline              With --list-models: show five supported models without HTTP
  --model <id>           Explicit choice for this batch; omitted => selection_required
  --size <WxH|auto>      GPT only; default 1024x1536
  --quality <level>      GPT only; default medium
  --image-size <1K|2K|4K> Gemini only; default 1K
  --aspect-ratio <W:H>   Gemini only; nearest supported source ratio if omitted
  --transport <mode>    auto (default), sync or async; Gemini supports sync only
  --depth <1-10>        Prompt level or 5 if omitted; bare integer also accepted
  --output-dir <dir>    Must be new; existing directories are never overwritten
  --dry-run             Validate without HTTP calls or task files
  --resume <run-dir>    Recover saved response/file or poll known ID; never POST
  --poll-interval-ms <n> Default 4000; 10..60000
  --wait-timeout-ms <n>  Polling time budget; default 300000; 1..3600000
  --request-timeout-ms <n> Per HTTP request; default async 60000, sync 360000
  --help`;
function parse(argv) {
  const flags = new Set(['--dry-run','--help','--list-models','--offline']);
  const options = new Set(['--image','--promptfile','--model','--size','--quality','--image-size','--aspect-ratio','--transport','--depth','--output-dir','--resume','--poll-interval-ms','--wait-timeout-ms','--request-timeout-ms']);
  const cfg={};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if (!key.startsWith('--') && /^\d+$/.test(key)) {
      if (cfg['--depth'] !== undefined) throw new Error('Duplicate depth: provide one bare number or --depth.');
      if (!/^(?:[1-9]|10)$/.test(key)) throw new Error('Depth must be an integer from 1 to 10.');
      cfg['--depth']=key; continue;
    }
    if (cfg[key] !== undefined) throw new Error(`Duplicate option: ${key}`);
    if (flags.has(key)) cfg[key]=true;
    else if (options.has(key)) {
      if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Missing value: ${key}`);
      cfg[key]=argv[++i];
    } else throw new Error(`Unknown option: ${key}`);
  }
  return cfg;
}
function redact(value) {
  let s=String(value); if(process.env.OPENAI_API_KEY) s=s.split(process.env.OPENAI_API_KEY).join('[REDACTED]');
  return s.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]');
}
function display(value) { console.log(redact(JSON.stringify(value,null,2))); }
async function saveJson(file, value) { await writeFile(file,redact(JSON.stringify(value,null,2))+'\n','utf8'); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
function hash(b) { return createHash('sha256').update(b).digest('hex'); }
function localFolderStamp(date=new Date()) {
  const two=value=>String(value).padStart(2,'0');
  return `${two(date.getMonth()+1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}
async function defaultOutputDir(source, date=new Date()) {
  const parent=path.dirname(source), stamp=localFolderStamp(date);
  for(let suffix=0;suffix<10000;suffix++) {
    const name=suffix===0?stamp:`${stamp}-${String(suffix).padStart(2,'0')}`;
    const candidate=path.join(parent,name);
    if(!(await exists(candidate))) return candidate;
  }
  throw new Error('Unable to find an unused output directory beside the reference image.');
}
function baseRoot() { return process.env.OPENAI_BASE_URL || 'https://vip.brioi.com/v1'; }
function enabled() { return ['1','true','yes','on','y'].includes(String(process.env.ENABLE_GARDEN_IMAGEGEN || '').trim().toLowerCase()); }
function numeric(raw, fallback, min, max) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw)<min || Number(raw)>max) throw new Error(`Timeout/interval must be an integer from ${min} to ${max}.`);
  return Number(raw);
}
function timers(cfg, settings) {
  return { poll_interval_ms:numeric(cfg['--poll-interval-ms'],4000,10,60000), wait_timeout_ms:numeric(cfg['--wait-timeout-ms'],300000,1,3600000), request_timeout_ms:numeric(cfg['--request-timeout-ms'],settings.transport==='gpt-async'?60000:360000,1,3600000) };
}
async function finish(dir, state, response, persist) {
  const bytes=await resultBytes(state, response), info=imageInfo(bytes);
  const target=path.join(dir,`result${info.extension}`);
  state.status='download_pending'; state.output={path:target,...info}; await persist();
  await writeFile(target,bytes);
  state.status='completed'; state.finished_at=new Date().toISOString();
  state.elapsed_seconds=Math.round((Date.now()-Date.parse(state.started_at))/100)/10;
  delete state.error; delete state.next_step; await persist();
}
function handles(dir,state) {
  return {
    persist:()=>saveJson(path.join(dir,'run.json'),state),
    saveResponse:response=>saveJson(path.join(dir,'provider-response.json'),response),
  };
}
async function resume(raw) {
  const dir=path.resolve(raw), state=JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  const {persist,saveResponse}=handles(dir,state);
  const result=state.output?.path || path.join(dir,'result.png');
  if(await exists(result)) {
    const info=imageInfo(await readFile(result));
    if(state.output?.sha256 && state.output.sha256!==info.sha256) throw new Error('Output hash differs from journal; inspect before any further action.');
    state.output={path:result,...info};
    if(state.status!=='completed') {state.status='completed';state.recovered_at=new Date().toISOString();await persist();}
    display({...state,resume:'verified_local_file_only',posted_again:false}); return;
  }
  if(state.status==='completed') throw new Error('Completed journal has no result file; inspect before further action.');
  if(['failed','cancelled','rejected'].includes(state.status)) {display({...state,posted_again:false});process.exitCode=1;return;}
  if(!state.transport) {display({...state,posted_again:false,next_step:'Legacy synchronous run has no recoverable task ID; reconcile provider records.'});return;}
  modelInfo(state.model);
  let response;
  const responseFile=path.join(dir,'provider-response.json');
  if(await exists(responseFile)) response=JSON.parse(await readFile(responseFile,'utf8'));
  try {
    if(state.transport==='gpt-async') {
      if(!state.task_id) {display({...state,posted_again:false,next_step:'Missing task ID. Reconcile provider records before any new POST.'});return;}
      if(!process.env.OPENAI_API_KEY || apiBase(baseRoot())!==apiBase(state.base_url)) throw new Error('Resume needs the original provider base URL and API key.');
      response=await poll(state,process.env.OPENAI_API_KEY,state,persist,saveResponse);
    }
    if(response) await finish(dir,state,response,persist);
  } catch(error) {state.status=state.task_id?'pending':'unknown';state.error=redact(error.message);await persist();}
  display({...state,posted_again:false,resume:'existing_request_only'});
  if(state.status!=='completed') process.exitCode=2;
}
async function run() {
  const cfg=parse(process.argv.slice(2));
  if(cfg['--help']) {console.log(help);return;}
  if(Number(process.versions.node.split('.')[0])<22) throw new Error('Node.js 22+ is required.');
  await loadAmbientEnv();
  if(cfg['--resume']) {
    if(Object.keys(cfg).length!==1) throw new Error('--resume cannot be combined with generation options.');
    await resume(cfg['--resume']);return;
  }
  if(cfg['--list-models']) {
    if(Object.keys(cfg).some(k=>!['--list-models','--offline'].includes(k))) throw new Error('--list-models cannot be combined with generation options.');
    display(cfg['--offline']?{status:'offline_catalog',models:MODELS.map(m=>({...m,listed:null,generation_verified:false})),requests_sent:0}:await availableModels(baseRoot(),process.env.OPENAI_API_KEY));return;
  }
  if(cfg['--offline']) throw new Error('--offline is only for --list-models.');
  if(!cfg['--image']||!cfg['--promptfile']) throw new Error('--image and --promptfile are required.');
  const source=path.resolve(cfg['--image']), promptFile=path.resolve(cfg['--promptfile']);
  if(!(await stat(source)).isFile()) throw new Error('Reference must be a file.');
  const sourceBytes=await readFile(source), sourceInfo=imageInfo(sourceBytes);
  const inputPromptText=(await readFile(promptFile,'utf8')).replace(/^\uFEFF/,'').trim(), prompt=JSON.parse(inputPromptText);
  if(!prompt || Array.isArray(prompt) || typeof prompt.goal!=='string' || !prompt.goal.trim() || !Array.isArray(prompt.subject?.products) || !prompt.subject.products.length || !prompt.constraints || typeof prompt.constraints!=='object') throw new Error('Fill a JSON prompt with goal, subject.products and constraints before running.');
  const effectivePrompt=applyReconstruction(prompt,cfg['--depth']), promptText=JSON.stringify(effectivePrompt,null,2);
  if(!cfg['--model']) {
    display({status:'model_selection_required',models:MODELS,configured_model_hint:process.env.OPENAI_IMAGE_MODEL||null,depth:effectivePrompt.reconstruction.level,n:1,requests_sent:0,output_files_written:0,next_step:'Ask the user to select a model by name for this batch, then pass --model. A bare number remains reconstruction depth.'});process.exitCode=2;return;
  }
  const settings=modelSettings({model:cfg['--model'],base:baseRoot(),transport:cfg['--transport'],size:cfg['--size'],quality:cfg['--quality'],imageSize:cfg['--image-size'],aspectRatio:cfg['--aspect-ratio'],source:sourceInfo});
  Object.assign(settings,timers(cfg,settings));
  const common={...settings,n:1,depth:effectivePrompt.reconstruction.level,depth_profile:effectivePrompt.reconstruction.profile,has_api_key:Boolean(process.env.OPENAI_API_KEY),local_mode_enabled:enabled()};
  if(cfg['--dry-run']) {display({status:'dry_run',...common,reconstruction:effectivePrompt.reconstruction,source,source_sha256:hash(sourceBytes),prompt:promptFile,prompt_sha256:hash(promptText),requests_sent:0,output_files_written:0});return;}
  if(!enabled()||!process.env.OPENAI_API_KEY) throw new Error('Local mode needs ENABLE_GARDEN_IMAGEGEN=1 and OPENAI_API_KEY. No generation request sent.');
  const dir=path.resolve(cfg['--output-dir']||await defaultOutputDir(source));
  if(await exists(dir)) throw new Error('Output directory already exists; use --resume, never overwrite or repost.');
  const list=await availableModels(settings.base_url,process.env.OPENAI_API_KEY);
  if(!list.models.find(m=>m.id===settings.model)?.listed) throw new Error(`Selected model is not listed for this API key: ${settings.model}. No generation request sent.`);
  await mkdir(path.dirname(dir),{recursive:true}); await mkdir(dir);
  const snapshot=path.join(dir,`reference${sourceInfo.extension}`);
  const state={skill:'pinshuai-image',version:'1.3.6',status:'prepared',visual_review:'not_reviewed',started_at:new Date().toISOString(),...common,source:{path:source,sha256:hash(sourceBytes),snapshot},prompt:{path:path.join(dir,'prompt.json'),sha256:hash(promptText)},output:{path:path.join(dir,'result.png')},request_count:0};
  const {persist,saveResponse}=handles(dir,state);
  await writeFile(snapshot,sourceBytes);await writeFile(path.join(dir,'prompt-input.json'),inputPromptText+'\n','utf8');await writeFile(state.prompt.path,promptText+'\n','utf8');await writeFile(path.join(dir,'prompt-used.md'),promptText+'\n','utf8');await saveJson(path.join(dir,'source.json'),state.source);await persist();
  try {
    state.status='request_started';state.request_count=1;await persist();
    let response=await submit(settings,process.env.OPENAI_API_KEY,sourceBytes,promptText);
    if(settings.transport==='gpt-async' && typeof response.task_id==='string' && response.task_id) state.task_id=response.task_id;
    await persist();await saveResponse(response);
    if(settings.transport==='gpt-async') response=await poll(settings,process.env.OPENAI_API_KEY,state,persist,saveResponse,response);
    if(response) await finish(dir,state,response,persist);
  } catch(error) {
    state.status=error instanceof HttpError && error.status>=400 && error.status<500 && !state.task_id?'rejected':state.task_id?'pending':'unknown';
    state.http_status=error.status||null;state.error=redact(error.message);state.finished_at=new Date().toISOString();state.elapsed_seconds=Math.round((Date.now()-Date.parse(state.started_at))/100)/10;await persist();
    try { state.casebook=await recordRuntimeFailure(dir,state); }
    catch { state.casebook={recorded:false,reason:'local_casebook_unavailable'}; }
    await persist();
  }
  await writeFile(path.join(dir,'stderr.log'),redact(state.error||state.last_poll_error||''),'utf8');
  await writeFile(path.join(dir,'stdout.log'),redact(JSON.stringify({status:state.status,model:state.model,task_id:state.task_id,output:state.status==='completed'?state.output:undefined}))+'\n','utf8');
  display(state);if(state.status!=='completed') process.exitCode=['pending','pending_unrecognized'].includes(state.status)?2:1;
}
run().catch(error=>{console.error(redact(error.message));process.exitCode=1;});
