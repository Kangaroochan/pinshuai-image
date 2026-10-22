export const MODELS = [
  { id: 'gpt-image-2', family: 'gpt', label: 'GPT Image 2' },
  { id: 'gpt-image-2.5-flare', family: 'gpt', label: 'GPT Image 2.5 Flare' },
  { id: 'gpt-image-2.5-sunburst', family: 'gpt', label: 'GPT Image 2.5 Sunburst' },
  { id: 'gemini-3.1-flash-image', family: 'gemini', label: 'Gemini 3.1 Flash Image' },
  { id: 'gemini-3.0-pro-image', family: 'gemini', label: 'Gemini 3.0 Pro Image' },
];
export function modelInfo(id) {
  const model = MODELS.find(m => m.id === id);
  if (!model) throw new Error(`Unsupported model: ${id}. Use --list-models; Nano Banana and Seedream are outside this skill's local-image scope.`);
  return model;
}
export function apiBase(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Base URL must be a clean HTTP(S) API root without credentials, query or fragment.');
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname || u.pathname === '/') u.pathname = '/v1';
  return u.href.replace(/\/$/, '');
}
export function modelSettings({ model, base, transport = 'auto', size, quality, imageSize, aspectRatio, source }) {
  const info = modelInfo(model);
  const baseUrl = apiBase(base);
  if (!['auto', 'sync', 'async'].includes(transport)) throw new Error('Transport must be auto, sync or async.');
  if (info.family === 'gpt') {
    if (imageSize || aspectRatio) throw new Error('GPT uses --size/--quality; --image-size/--aspect-ratio are Gemini options.');
    size ||= '1024x1536'; quality ||= 'medium';
    if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('Unsupported quality.');
    if (size !== 'auto') {
      const m = /^(\d+)x(\d+)$/.exec(size);
      if (!m) throw new Error('Size must be WxH or auto.');
      const [w, h] = m.slice(1).map(Number);
      if (w % 16 || h % 16 || Math.min(w, h) < 16 || Math.max(w, h) > 3840 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400) throw new Error('GPT size needs 16px multiples, max edge 3840, max ratio 3:1 and 655360..8294400 pixels.');
    }
    const route = transport === 'auto' ? (new URL(baseUrl).hostname === 'vip.brioi.com' ? 'async' : 'sync') : transport;
    return { model, family: info.family, base_url: baseUrl, transport: `gpt-${route}`, size, quality, n: 1 };
  }
  if (transport === 'async') throw new Error('Gemini native image generation is synchronous; no async task ID is available.');
  if (size || quality) throw new Error('Gemini uses --image-size/--aspect-ratio; do not pass GPT --size/--quality.');
  imageSize ||= '1K';
  if (!['1K', '2K', '4K'].includes(imageSize)) throw new Error('Gemini image size must be 1K, 2K or 4K.');
  const ratios = info.id === 'gemini-3.1-flash-image'
    ? ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '16:9', '9:16', '21:9']
    : ['1:1', '2:3', '3:2', '3:4', '4:3', '16:9', '9:16', '21:9', '9:21'];
  if (!aspectRatio) {
    const target = source.width / source.height;
    aspectRatio = [...ratios].sort((a, b) => {
      const ratio = s => { const [w,h] = s.split(':').map(Number); return w/h; };
      return Math.abs(Math.log(ratio(a)/target)) - Math.abs(Math.log(ratio(b)/target));
    })[0];
  }
  if (!ratios.includes(aspectRatio)) throw new Error(`Unsupported aspect ratio for ${model}: ${aspectRatio}`);
  return { model, family: info.family, base_url: baseUrl, transport: 'gemini-sync', image_size: imageSize, aspect_ratio: aspectRatio, n: 1 };
}
export async function availableModels(base, key) {
  if (!key) return { status: 'missing_key', models: MODELS.map(m => ({ ...m, listed: null, generation_verified: false })) };
  const response = await fetch(`${apiBase(base)}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Model list HTTP ${response.status}; no generation request sent.`);
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error('Model list response has no data array.');
  const ids = new Set(data.data.map(m => m.id));
  return { status: 'listed', models: MODELS.map(m => ({ ...m, listed: ids.has(m.id), generation_verified: false })) };
}
