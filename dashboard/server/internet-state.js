const terminal = session => ['ended', 'failed'].includes(session.state);
const iso = value => value ? new Date(value).toISOString() : null;
const fresh = (value, now) => value && Number.isFinite(+new Date(value)) && +now - +new Date(value) <= 180000 && +new Date(value) <= +now + 5000;

// Public projection of one device's intent and last router confirmation. The
// underlying sessions retain reward accounting; clients need not guess a mode.
export function deviceAccessState(device, sessions, commands, now = new Date()) {
  const own = sessions.filter(session => session.device_id === device.id), live = own.filter(session => !terminal(session));
  const pending = commands.filter(command => ['pending','leased','attention'].includes(command.state)
    && (command.device_id === device.id || own.some(session => session.id === command.session_id)));
  const session = live.find(session => session.desired_state === 'allowed') || live[0];
  const expired = session?.ends_at && +new Date(session.ends_at) <= +now;
  const desiredMode = device.desired_access === 'allowed' ? 'on' : session?.desired_state === 'allowed' && !expired ? 'timed' : 'off';
  const verifiedAt = session ? session.verified_at : device.access_verified_at;
  const error = device.access_error || session?.last_error || pending.find(command => command.last_error)?.last_error || null;
  let confirmedMode = 'unknown';
  if (!error && fresh(verifiedAt, now)) {
    if (session?.observed_state === 'allowed' && !expired) confirmedMode = 'timed';
    else if ((!session || session.observed_state === 'blocked') && device.observed_access === 'blocked') confirmedMode = 'off';
    else if (!session && device.observed_access === 'allowed') confirmedMode = 'on';
  }
  const phase = pending.some(command => command.state === 'attention') ? 'attention' : pending.length ? 'pending'
    : error ? 'attention' : !fresh(verifiedAt, now) ? 'stale' : confirmedMode === desiredMode ? 'confirmed' : 'pending';
  return { desiredMode, confirmedMode, phase, verifiedAt: iso(verifiedAt), endsAt: iso(session?.ends_at),
    sessionId: session?.id || null, error, retryable: phase === 'attention',
    message: phase === 'attention' ? 'Access is not confirmed. Retry the requested mode or choose Off.'
      : phase === 'stale' ? 'Waiting for a fresh router check. Previous status is no longer current.'
      : phase === 'pending' ? 'Request saved. Waiting for router confirmation.' : 'Router configuration confirmed.' };
}
