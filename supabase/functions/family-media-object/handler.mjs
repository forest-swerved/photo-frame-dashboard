const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
export async function signature(secret, operation, key, timestamp, body) {
  const digest = hex(await crypto.subtle.digest('SHA-256', body));
  const signingKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', signingKey, encoder.encode([operation, key, timestamp, digest].join('\n'))));
}
export function createMediaObjectHandler({ storage, secret, now = () => Date.now(), fetcher = fetch }) {
  return async request => {
    const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      const operation = request.headers.get('x-media-operation'), key = request.headers.get('x-media-key') || '', timestamp = request.headers.get('x-media-time') || '';
      if (request.method !== 'POST' || !secret || secret.length < 32 || !['upload','read-url','upload-url','inspect','delete'].includes(operation)
        || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|mp4)$/.test(key) || !/^\d{13}$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 60_000) return reply({ error: 'unauthorized' }, 401);
      const reader = request.body?.getReader(), parts = []; let size = 0;
      if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 3_000_000) { await reader.cancel(); return reply({ error: 'too_large' }, 413); } parts.push(value); }
      const body = new Uint8Array(size); let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.length; }
      const expected = await signature(secret, operation, key, timestamp, body), actual = request.headers.get('x-media-signature') || '';
      let mismatch = actual.length ^ expected.length;
      for (let index = 0; index < expected.length; index++) mismatch |= expected.charCodeAt(index) ^ (actual.charCodeAt(index) || 0);
      if (mismatch) return reply({ error: 'unauthorized' }, 401);
      const bucket = storage.from('family-media');
      let result;
      if (operation === 'upload') {
        if (!key.endsWith('.jpg') || !size) return reply({ error: 'invalid_media' }, 422);
        result = await bucket.upload(key, body, { contentType: 'image/jpeg', cacheControl: '0', upsert: false });
      }
      if (operation === 'upload-url') {
        if (!key.endsWith('.mp4') || size) return reply({ error: 'invalid_media' }, 422);
        result = await bucket.createSignedUploadUrl(key, { upsert: false });
      }
      if (operation === 'read-url') result = await bucket.createSignedUrl(key, 300);
      if (operation === 'delete') result = await bucket.remove([key]);
      if (operation === 'inspect') {
        const signed = await bucket.createSignedUrl(key, 30);
        if (signed.error) return reply({ error: 'storage_unavailable' }, 502);
        const response = await fetcher(signed.data.signedUrl, { headers: { Range: 'bytes=0-255' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (response.status !== 206) { await response.body?.cancel(); return reply({ error: 'invalid_media' }, 422); }
        const bytes = Number(response.headers.get('content-range')?.split('/')[1]), data = new Uint8Array(await response.arrayBuffer());
        const isMP4 = new TextDecoder().decode(data.slice(4, 8)) === 'ftyp';
        if (!isMP4 || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > 52428800 || !response.headers.get('content-type')?.startsWith('video/mp4')) return reply({ error: 'invalid_media' }, 422);
        return reply({ bytes });
      }
      if (result?.error) return reply({ error: 'storage_unavailable' }, 502);
      return reply(operation.endsWith('url') ? { url: result.data.signedUrl } : { ok: true });
    } catch { return reply({ error: 'storage_unavailable' }, 502); }
  };
}
