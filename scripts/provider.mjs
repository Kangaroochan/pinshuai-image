import { imageInfo, decodeBase64 } from './image-files.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(`Image API error (${status}): ${message}`); this.status = status; }
}
function endpoint(settings) {
  if (settings.transport === 'gemini-sync') return `${settings.base_url.replace(/\/v1(?:beta)?$/, '')}/v1beta/models/${settings.model}:generateContent`;
  return `${settings.base_url}/images/${settings.transport === 'gpt-async' ? 'async/' : ''}edits`;
}
async function request(url, { key, method = 'GET', body, json = false, timeout }) {
  const response = await fetch(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new HttpError(response.status, (await response.text()).slice(0, 3000));
  return response.json();
}
export async function submit(settings, key, source, prompt) {
  if (settings.transport === 'gemini-sync') {
    const info = imageInfo(source);
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: info.mime_type, data: source.toString('base64') } }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: settings.image_size, aspectRatio: settings.aspect_ratio } } };
    return request(endpoint(settings), { key, method: 'POST', body: JSON.stringify(body), json: true, timeout: settings.request_timeout_ms });
  }
  const info = imageInfo(source), form = new FormData();
  form.append(settings.transport === 'gpt-async' ? 'image[]' : 'image', new Blob([source], { type: info.mime_type }), `reference${info.extension}`);
  for (const [name, value] of Object.entries({ model: settings.model, prompt, size: settings.size, quality: settings.quality, n: 1, output_format: 'png' })) form.append(name, String(value));
  return request(endpoint(settings), { key, method: 'POST', body: form, timeout: settings.request_timeout_ms });
}
function statusOf(value) {
  const status = String(value || '').toUpperCase();
  if (['SUBMITTED', 'QUEUED', 'PENDING', 'RUNNING', 'PROCESSING', 'IN_PROGRESS'].includes(status)) return 'pending';
  if (['SUCCESS', 'SUCCEEDED', 'COMPLETED'].includes(status)) return 'succeeded';
  if (['FAILURE', 'FAILED'].includes(status)) return 'failed';
  if (['CANCELLED', 'CANCELED'].includes(status)) return 'cancelled';
  return 'unrecognized';
}
export async function poll(settings, key, state, persist, saveResponse, initial) {
  if (!state.task_id) throw new Error('No async task ID; cannot poll or safely resubmit.');
  const deadline = Date.now() + settings.wait_timeout_ms;
  let response = initial;
  while (true) {
    try {
      if (!response) {
        response = await request(`${endpoint(settings)}/${encodeURIComponent(state.task_id)}`, { key, timeout: Math.min(settings.request_timeout_ms, 45000) });
        await saveResponse(response);
      }
      if (response.task_id && response.task_id !== state.task_id) throw new Error('Provider returned a different task ID; inspect the saved response.');
      state.provider_status = response.status || null;
      const status = statusOf(response.status);
      state.status = status === 'unrecognized' ? 'pending_unrecognized' : status;
      await persist();
      if (status === 'succeeded') return response;
      if (status === 'failed' || status === 'cancelled') {
        state.error = response.fail_reason || response.error?.message || `Provider task ${status}`;
        await persist(); return null;
      }
    } catch (error) {
      state.status = 'pending'; state.last_poll_error = error.message; await persist();
      // A GET error never authorizes a second POST. Authentication failures need attention.
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) return null;
    }
    if (Date.now() >= deadline) {
      state.status = 'pending'; state.next_step = 'Use --resume with this directory to query the same task ID. No new POST.'; await persist(); return null;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(settings.poll_interval_ms, Math.max(1, deadline-Date.now()))));
    response = null;
  }
}
function remoteUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Generated image URL must use HTTPS.');
  if (u.username || u.password) throw new Error('Image URL contains embedded credentials.');
  return u.href;
}
async function download(raw) {
  const url = remoteUrl(raw);
  // Never forward API credentials to image storage, including redirects.
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Generated image download HTTP ${response.status}; preserve response and retry only download.`);
  const bytes = Buffer.from(await response.arrayBuffer()); imageInfo(bytes); return bytes;
}
export async function resultBytes(settings, response) {
  if (settings.transport === 'gemini-sync') {
    const parts = (response.candidates || []).flatMap(c => c.content?.parts || []);
    const inline = parts.filter(p => p.inlineData?.data);
    if (inline.length) {
      const unique = new Map();
      for (const part of inline) {
        const bytes = decodeBase64(part.inlineData.data), info = imageInfo(bytes);
        if (part.inlineData.mimeType && part.inlineData.mimeType !== info.mime_type) throw new Error('Gemini image MIME differs from actual bytes.');
        unique.set(info.sha256, bytes);
      }
      if (unique.size !== 1) throw new Error('Expected one unique Gemini image; inspect saved response, no retry.');
      return [...unique.values()][0];
    }
    const files = parts.flatMap(p => p.fileData?.fileUri ? [p.fileData.fileUri] : []);
    const markdown = parts.flatMap(p => [...String(p.text || '').matchAll(/!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g)].map(m => m[1]));
    const urls = [...new Set([...files, ...markdown].map(remoteUrl))];
    if (urls.length !== 1) throw new Error('Expected one unique Gemini image URL; inspect saved response, no retry.');
    return download(urls[0]);
  }
  const images = settings.transport === 'gpt-async' ? response.images : response.data;
  if (!Array.isArray(images) || images.length !== 1) throw new Error('Expected exactly one result; inspect saved response before retrying.');
  if (images[0].b64_json) return decodeBase64(images[0].b64_json);
  if (images[0].url) return download(images[0].url);
  throw new Error('Image response contains no usable image; no new request sent.');
}
