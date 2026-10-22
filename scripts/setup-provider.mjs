#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { apiBase } from './models.mjs';
import { loadAmbientEnv } from './shared.js';

const KEYS = ['ENABLE_GARDEN_IMAGEGEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
const enabled = value => ['1', 'true', 'yes', 'on', 'y'].includes(String(value || '').trim().toLowerCase());

export function localConfig(text) {
  const result = {};
  for (const key of KEYS) {
    const lines = text.split(/\r?\n/).filter(line => new RegExp('^\\s*' + key + '\\s*=').test(line));
    if (lines.length > 1) throw new Error('本地配置存在重复字段，请先在本机整理 .env；未修改文件。');
    if (!lines.length) { result[key] = ''; continue; }
    let raw = lines[0].slice(lines[0].indexOf('=') + 1).trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
    result[key] = raw;
  }
  return result;
}

export function fillMissing(text, additions) {
  const present = localConfig(text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let result = text;
  for (const key of KEYS) {
    if (present[key] || !additions[key]) continue;
    const value = String(additions[key]);
    if (/[\r\n\0]/.test(value) || (value.includes('"') && value.includes("'"))) throw new Error('配置值含不支持的控制字符或引号；未修改文件。');
    const quoted = value.includes('"') ? "'" + value + "'" : '"' + value + '"';
    const matcher = new RegExp('^([ \\t]*' + key + '[ \\t]*=)[^\\r\\n]*', 'm');
    if (matcher.test(result)) result = result.replace(matcher, (_, prefix) => prefix + quoted);
    else result += (result && !result.endsWith('\n') ? newline : '') + key + '=' + quoted + newline;
  }
  return result;
}

export function ignoredEnv(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim());
  const rules = ['.env', '.env.*', '!.env.example'];
  if (rules.every(rule => lines.includes(rule))) return text;
  return text + (text && !text.endsWith('\n') ? '\n' : '') + '\n# Local API credentials\n' + rules.join('\n') + '\n';
}

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveConfiguration(directory, snapshot, additions) {
  const envPath = path.join(directory, '.env');
  if (await readOptional(envPath) !== snapshot) throw new Error('配置文件已被其他程序修改，请重新运行；未覆盖文件。');
  const next = fillMissing(snapshot || '', additions);
  const gitignore = path.join(directory, '.gitignore');
  const previous = await readOptional(gitignore);
  const ignoreText = ignoredEnv(previous || '');
  if (ignoreText !== previous) await writeFile(gitignore, ignoreText, { encoding: 'utf8', flag: previous === null ? 'wx' : 'w' });
  // Check again after writing .gitignore. Never create a new .env over an existing file.
  if (await readOptional(envPath) !== snapshot) throw new Error('配置文件已被其他程序修改，请重新运行；未覆盖文件。');
  if (next !== snapshot) await writeFile(envPath, next, { encoding: 'utf8', mode: 0o600, flag: snapshot === null ? 'wx' : 'w' });
}

async function askHidden(prompt) {
  stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin) {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') throw new Error('已取消配置。');
        if (char === '\r' || char === '\n') { stdout.write('\n'); return value.trim(); }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
  }
  throw new Error('未读取到 API Key。');
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  if (process.argv.slice(2).some(arg => arg !== '--status')) throw new Error('仅支持交互配置或 --status；请勿把 API Key 放入命令参数。');
  await loadAmbientEnv();
  const values = Object.fromEntries(KEYS.map(key => [key, process.env[key] || '']));
  const ready = enabled(values.ENABLE_GARDEN_IMAGEGEN) && Boolean(values.OPENAI_BASE_URL) && Boolean(values.OPENAI_API_KEY);
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({
      ready,
      api_enabled: enabled(values.ENABLE_GARDEN_IMAGEGEN),
      config: Object.fromEntries(KEYS.map(key => [key, values[key] ? 'SET' : 'MISSING'])),
      network_requests: 0
    }, null, 2));
    return;
  }
  if (ready) { stdout.write('第三方 API 配置已存在，没有修改本地配置。\n'); return; }
  if (values.ENABLE_GARDEN_IMAGEGEN && !enabled(values.ENABLE_GARDEN_IMAGEGEN)) {
    throw new Error('现有配置关闭了 API，未覆盖。若要启用，请在本机将 ENABLE_GARDEN_IMAGEGEN 改为 1 后重新运行。');
  }
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('此命令需要交互式终端；请在本机终端重新运行。');
  const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const relative = path.relative(skillDir, process.cwd());
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('请在业务项目根目录运行配置命令；不要在技能目录中保存 Key。');
  const envPath = path.resolve('.env');
  const snapshot = await readOptional(envPath);
  const local = localConfig(snapshot || '');
  const additions = {};
  if (!values.OPENAI_BASE_URL) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let entered;
    try { entered = (await rl.question('Base URL [https://vip.brioi.com/v1]: ')).trim(); }
    finally { rl.close(); }
    let normalized;
    try { normalized = apiBase(entered || 'https://vip.brioi.com/v1'); }
    catch { throw new Error('Base URL 格式无效，请填写无账号、查询参数及片段的 HTTP(S) 接口地址。'); }
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Base URL 必须使用 HTTPS（本地回环地址除外）。');
    additions.OPENAI_BASE_URL = normalized;
  }
  if (!values.OPENAI_API_KEY) {
    additions.OPENAI_API_KEY = await askHidden('API Key（输入内容不会显示）: ');
    if (!additions.OPENAI_API_KEY || /[\s\0]/.test(additions.OPENAI_API_KEY)) throw new Error('API Key 不能为空或含空白、控制字符。');
  }
  if (!values.ENABLE_GARDEN_IMAGEGEN) additions.ENABLE_GARDEN_IMAGEGEN = '1';
  for (const key of KEYS) if (local[key]) delete additions[key];
  await saveConfiguration(process.cwd(), snapshot, additions);
  stdout.write('本地配置已补齐，.gitignore 已保护 .env；现有值保持不变，环境变量中的 Key 不会复制到文件。\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Do not echo arbitrary exception messages that might contain terminal input.
    const known = /^(需要|仅支持|现有配置|此命令|请在|本地配置|配置文件|Base URL|API Key|配置值|已取消|未读取)/.test(error.message);
    stdout.write('配置未完成：' + (known ? error.message : '本地文件读写失败；请检查目录权限。') + '\n');
    process.exitCode = 1;
  });
}
