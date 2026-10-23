#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const casebookPath = () => path.resolve(process.env.PINSHUAI_CASEBOOK_PATH || path.join(skillRoot, '.local', 'failure-cases.md'));
const header = '# Pinshuai Image 本地案例簿\n\n仅保存经确认的视觉验收案例和脱敏运行元数据。案例供后续提示词规划参考，不代表模型训练数据；单个案例不会自动修改通用规则。\n\n';

function clean(value, max = 360) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|key)-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/g, '[LOCAL_PATH]')
    .replace(/(?:[A-Z]:)?\/(?:[^\s<>]+\/)*[^\s<>]*/gi, '[LOCAL_PATH]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, max);
}

function fingerprint(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

async function records() {
  let text;
  try { text = await readFile(casebookPath(), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  const blocks = new RegExp('```json\\s*\\n([\\s\\S]*?)\\n```', 'g');
  for (const match of text.matchAll(blocks)) {
    try { result.push(JSON.parse(match[1])); } catch { /* Ignore incomplete manual edits. */ }
  }
  return result;
}

async function appendCase(record) {
  const file = casebookPath();
  const existing = await records();
  if (existing.some(item => item.dedupe_key === record.dedupe_key)) return { recorded: false, duplicate: true, case_id: existing.find(item => item.dedupe_key === record.dedupe_key).case_id };
  await mkdir(path.dirname(file), { recursive: true });
  try { await readFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(file, header, 'utf8'); }
  const safe = { case_id: randomUUID(), recorded_at: new Date().toISOString(), ...record };
  const block = `\n## ${safe.kind === 'visual_review' ? '视觉复核' : '运行失败'} | ${safe.case_id}\n\n\`\`\`json\n${JSON.stringify(safe, null, 2)}\n\`\`\`\n`;
  await appendFile(file, block, 'utf8');
  return { recorded: true, case_id: safe.case_id };
}

export async function recordRuntimeFailure(runDir, state) {
  if (state.status === 'completed' || state.status === 'prepared' || state.status === 'request_started') return { recorded: false, reason: 'not_a_final_failure' };
  const code = Number(state.http_status) || null;
  const terminal = ['failed', 'cancelled', 'rejected'].includes(state.status);
  const category = code >= 400 && code < 500
    ? 'provider_rejected'
    : terminal ? 'provider_terminal_failure'
      : code >= 500 ? 'provider_error_uncertain'
        : 'submission_or_transport_uncertain';
  return appendCase({
    dedupe_key: `runtime:${path.basename(runDir)}:${category}`,
    kind: 'runtime_failure',
    run_id: path.basename(runDir),
    category,
    status: clean(state.status, 40),
    confidence: terminal && !(code >= 500) ? 'confirmed' : 'unconfirmed',
    model: clean(state.model, 80),
    depth: Number.isInteger(state.depth) ? state.depth : null,
    http_status: code,
    prompt_sha256: /^[a-f0-9]{64}$/i.test(state.prompt?.sha256 || '') ? state.prompt.sha256 : null,
    source_sha256: /^[a-f0-9]{64}$/i.test(state.source?.sha256 || '') ? state.source.sha256 : null,
    error_fingerprint: fingerprint(state.error || state.last_poll_error || category),
    root_cause: null,
    resolution: null,
  });
}

export async function recordVisualReview(runDir, review) {
  if (!review || review.visual_review !== 'reviewed') throw new Error('Only a completed visual_review=reviewed report can enter the casebook.');
  const checks = review.checks && typeof review.checks === 'object' ? review.checks : {};
  const failures = Object.entries(checks).filter(([, status]) => status === 'fail').map(([category]) => category);
  const uncertainties = Object.entries(checks).filter(([, status]) => status === 'uncertain').map(([category]) => category);
  const decisions = Array.isArray(review.successful_decisions) ? review.successful_decisions.map(x => clean(x)).filter(Boolean) : [];
  if (!failures.length && !decisions.length) throw new Error('Reviewed report needs at least one failed check or successful_decisions entry.');
  const issues = Array.isArray(review.issues) ? review.issues.map(x => clean(x)).filter(Boolean).slice(0, 12) : [];
  return appendCase({
    dedupe_key: `visual:${path.basename(runDir)}`,
    kind: 'visual_review',
    run_id: path.basename(runDir),
    category: 'visual_quality',
    confidence: 'reviewed',
    failures,
    uncertainties,
    evidence: issues,
    successful_decisions: decisions,
    visual_pass: review.visual_pass === true,
  });
}

async function loadRun(dir) {
  return JSON.parse(await readFile(path.join(path.resolve(dir), 'run.json'), 'utf8'));
}

async function showLessons(filter = '') {
  const all = await records();
  const q = filter.toLowerCase();
  const eligible = all.filter(item => item.confidence === 'reviewed' || item.confidence === 'confirmed');
  const matching = eligible.filter(item => !q || JSON.stringify(item).toLowerCase().includes(q));
  const counts = new Map();
  for (const item of matching.filter(x => x.kind === 'visual_review')) {
    for (const category of item.failures || []) counts.set(category, (counts.get(category) || 0) + 1);
  }
  const recurring = [...counts.entries()].filter(([, count]) => count >= 2).map(([category, count]) => ({ category, confirmed_cases: count, state: 'candidate_rule_requires_review' }));
  console.log(JSON.stringify({
    casebook: casebookPath(),
    eligible_cases: matching.length,
    recurring_candidates: recurring,
    relevant_cases: matching.slice(-20).map(({ case_id, kind, run_id, category, failures, evidence, successful_decisions, model, depth }) => ({ case_id, kind, run_id, category, failures, evidence, successful_decisions, model, depth })),
    note: 'Use relevant evidence to plan this task. A recurring pattern is only a candidate; do not change general skill rules automatically.',
  }, null, 2));
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'record-run' && args.length === 1) {
    const dir = path.resolve(args[0]);
    const state = await loadRun(dir);
    console.log(JSON.stringify(await recordRuntimeFailure(dir, state)));
    return;
  }
  if (command === 'record-review' && args.length === 2) {
    const dir = path.resolve(args[0]);
    const review = JSON.parse(await readFile(path.resolve(args[1]), 'utf8'));
    console.log(JSON.stringify(await recordVisualReview(dir, review)));
    return;
  }
  if (command === 'lessons' && args.length <= 2 && (args.length === 0 || args[0] === '--category')) {
    await showLessons(args.length === 2 ? args[1] : '');
    return;
  }
  throw new Error('Usage: casebook.mjs record-run <run-dir> | record-review <run-dir> <visual-review.json> | lessons [--category <keyword>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(clean(error.message)); process.exitCode = 1; });
}
