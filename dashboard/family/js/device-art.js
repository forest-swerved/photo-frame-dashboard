// Names select recognizable hardware artwork; network identities never enter asset paths.
export function deviceArtwork(device) {
  const name = String(device.name || '').toLowerCase();
  if (device.kind === 'console') {
    if (/\bps\s?5\b|playstation/.test(name)) return 'ps5';
    if (name.includes('switch')) return 'switch';
  }
  if (device.kind === 'tablet' && /\bpro\b/.test(name)) return 'tablet-pro';
  if (device.kind === 'tv' && /apple\s*tv/.test(name)) return 'apple-tv';
  const generic = { tablet: 'tablet', phone: 'phone', computer: 'laptop', console: 'console', tv: 'apple-tv' };
  return Object.hasOwn(generic, device.kind) ? generic[device.kind] : 'other';
}
export const deviceArtworkImage = device => `<img class="device-art" src="/device-art/${deviceArtwork(device)}.svg" width="80" height="80" alt="" aria-hidden="true" decoding="async">`;
