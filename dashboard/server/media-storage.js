import { createHmac, createHash } from 'node:crypto';
import { ApiError, requireValue } from './errors.js';
export function createMediaStorage(env = process.env, fetcher = fetch) {
  return async (operation, key, body = Buffer.alloc(0)) => {
    const secret = env.FAMILY_MEDIA_GATEWAY_KEY;
    requireValue(secret?.length >= 32 && /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(env.SUPABASE_URL || ''), 503, 'media_unconfigured', 'Family media storage is not configured.');
    const timestamp = String(Date.now()), hash = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', secret).update([operation, key, timestamp, hash].join('\n')).digest('hex');
    try {
      const response = await fetcher(`${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/family-media-object`, {
        method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/octet-stream', 'x-media-operation': operation, 'x-media-key': key, 'x-media-time': timestamp, 'x-media-signature': signature },
      });
      if (!response.ok) throw new Error('storage');
      const data = await response.json();
      if (operation.endsWith('url')) {
        const url = new URL(data.url);
        if (url.origin !== new URL(env.SUPABASE_URL).origin || !url.pathname.startsWith('/storage/v1/object/')) throw new Error('storage');
      }
      return data;
    } catch { throw new ApiError(503, 'media_storage_unavailable', 'Media storage is temporarily unavailable. Try again.'); }
  };
}
