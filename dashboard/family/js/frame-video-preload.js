// Keep just the next clip warm. Its local blob and first decoded frame are
// ready before the visible slide changes; no network URL or audio is involved.
export function createFrameVideoPreloader(readLocalURL) {
  let slot;
  function dispose(value) {
    value.element.pause(); value.element.removeAttribute('src'); value.element.load(); value.element.remove();
    if (value.url) URL.revokeObjectURL(value.url);
  }
  function clear() { if (slot) dispose(slot); slot = undefined; }
  return {
    clear,
    warm(item) {
      if (item?.kind !== 'video') { clear(); return; }
      if (slot?.id === item.id) return;
      clear();
      const element = document.createElement('video');
      element.muted = true; element.playsInline = true; element.preload = 'auto';
      element.setAttribute('aria-hidden', 'true'); element.tabIndex = -1;
      element.dataset.framePreload = 'true';
      element.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
      const next = slot = { id:item.id, element, url:null };
      document.body.append(element);
      Promise.resolve(readLocalURL(item)).then(url => {
        if (slot !== next) { if (url) URL.revokeObjectURL(url); return; }
        if (!url) { clear(); return; }
        next.url = url; element.src = url; element.load();
      }).catch(() => { if (slot === next) clear(); });
    },
    take(id) {
      if (slot?.id !== id || !slot.url) { clear(); return null; }
      const ready = slot; slot = undefined;
      ready.element.removeAttribute('style'); ready.element.removeAttribute('aria-hidden'); ready.element.removeAttribute('tabindex');
      ready.element.removeAttribute('data-frame-preload'); ready.element.setAttribute('aria-label', 'Family video');
      return ready;
    },
  };
}
