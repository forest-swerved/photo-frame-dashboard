const prefix = 'family-frame-media-v1:';
const path = item => new URL(`/api/media/${item.id}/cached`, location.origin).href;
// Assets persist on this device, never in a public CDN or a credential-bearing
// cache key. Every session must first authenticate and obtain its current list.
export function createFrameMediaCache({ readURL, onAuthFailure = () => {} }) {
  let scope, generation = 0, cache, ready = new Set(), wanted = new Map(), running = false, controller, binding;
  function bind(next) {
    if (scope === next) return binding;
    scope = next; const epoch = ++generation; controller?.abort(); ready = new Set(); wanted = new Map(); running = false; cache = null;
    binding = (async () => {
    if (!globalThis.caches) return;
    try {
      for (const name of await caches.keys()) {
        if (epoch !== generation) return;
        if (name.startsWith(prefix) && name !== prefix + next) await caches.delete(name);
      }
      if (next) {
        const opened = await caches.open(prefix + next);
        if (epoch === generation) { cache = opened; for (const request of await cache.keys()) ready.add(request.url.split('/').at(-2)); }
      }
    } catch { /* The slideshow can retry after quota/storage becomes available. */ }
    })(); return binding;
  }
  async function sync(items) {
    wanted = new Map(items.map(item => [item.id, item]));
    if (!cache) return;
    const epoch = generation, currentCache = cache;
    for (const id of ready) if (!wanted.has(id)) { ready.delete(id); await currentCache.delete(path({ id })); }
    if (running || epoch !== generation) return;
    running = true; controller = new AbortController(); const signal = controller.signal;
    try {
      for (const item of items) {
        if (epoch !== generation) return;
        if (ready.has(item.id) || !wanted.has(item.id)) continue;
        try {
          const { url } = await readURL(item.id);
          if (epoch !== generation) return;
          const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal });
          if (!response.ok) throw new Error('download');
          const blob = await response.blob();
          if (epoch !== generation || !wanted.has(item.id)) continue;
          if (blob.size !== item.bytes || blob.size > 52428800) throw new Error('size');
          // Rebuild the response to avoid persisting the temporary signed URL.
          await currentCache.put(path(item), new Response(blob, { headers: { 'Content-Type': item.kind === 'video' ? 'video/mp4' : 'image/jpeg', 'Content-Length': String(blob.size) } }));
          if (epoch !== generation || !wanted.has(item.id)) { await currentCache.delete(path(item)); continue; }
          ready.add(item.id);
        } catch (error) {
          if (epoch !== generation || signal.aborted) return;
          if ([401,403].includes(error.status)) { onAuthFailure(error); return; }
          // Quota exhaustion or a disconnected network must not stall the clock.
          if (error.name === 'QuotaExceededError') break;
        }
      }
    } finally { if (epoch === generation) running = false; }
  }
  return { bind, sync, has: id => ready.has(id), count: () => ready.size,
    async url(item) {
      const epoch = generation;
      const response = await cache?.match(path(item));
      if (!response) { ready.delete(item.id); return null; }
      const blob = await response.blob();
      return epoch === generation && wanted.has(item.id) ? URL.createObjectURL(blob) : null;
    },
  };
}
