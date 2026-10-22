import { createHash } from 'node:crypto';
export function imageInfo(bytes) {
  let width, height, mime, extension;
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png'; extension = '.png';
  } else if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    for (let p = 12; p + 8 <= bytes.length;) {
      const type = bytes.subarray(p, p+4).toString(), size = bytes.readUInt32LE(p+4), d = p+8;
      if (d + size > bytes.length) break;
      if (type === 'VP8X' && size >= 10) { width = bytes.readUIntLE(d+4, 3)+1; height = bytes.readUIntLE(d+7, 3)+1; }
      if (type === 'VP8 ' && size >= 10 && bytes.subarray(d+3,d+6).toString('hex') === '9d012a') { width = bytes.readUInt16LE(d+6)&0x3fff; height = bytes.readUInt16LE(d+8)&0x3fff; }
      if (type === 'VP8L' && size >= 5 && bytes[d] === 0x2f) { const v = bytes.readUInt32LE(d+1); width = (v&0x3fff)+1; height = ((v>>>14)&0x3fff)+1; }
      if (width && height) break;
      p = d + size + (size % 2);
    }
    mime = 'image/webp'; extension = '.webp';
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p=2;
    while (p+4 <= bytes.length) {
      if (bytes[p++] !== 0xff) break;
      while (p < bytes.length && bytes[p] === 0xff) p++;
      const marker = bytes[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p+2 > bytes.length) break;
      const len=bytes.readUInt16BE(p);
      if (len < 2 || p+len > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && len >= 8) {
        height = bytes.readUInt16BE(p+3); width = bytes.readUInt16BE(p+5); break;
      }
      p += len;
    }
    mime = 'image/jpeg'; extension = '.jpg';
  }
  if (!width || !height) throw new Error('Invalid or unsupported image; expected PNG, JPEG or WebP with readable dimensions. Inspect the saved response before another request.');
  return { bytes: bytes.length, width, height, mime_type: mime, extension, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export function decodeBase64(raw) {
  if (typeof raw !== 'string' || !raw || raw.startsWith('data:') || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new Error('Invalid raw base64 image response.');
  const bytes = Buffer.from(raw, 'base64'); imageInfo(bytes); return bytes;
}
