import { processInternetJobs } from './internet-worker.js';

// The committed queue remains the source of truth; this only removes the cron
// wait. Multiple kicks retain the same global command lease and version checks.
export async function drainInternetQueue(db, { env = process.env, runJob = processInternetJobs,
  clock = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve,ms)), maxCommands = 6, maxMs = 25000 } = {}) {
  const started = clock().getTime(), summary = { processed: 0, expiredQueued: 0 };
  for (let n=0;n<maxCommands && clock().getTime()-started<maxMs;n++) {
    const result = await runJob(db,{env,now:clock(),clock});
    summary.processed += result.processed || 0; summary.expiredQueued += result.expiredQueued || 0;
    if (!result.processed) break;
    summary.state = result.state;
    if (['unifi_rate_limited','unifi_credentials_rejected','unifi_unavailable','unifi_deadline','network_unavailable'].includes(result.error)) {
      summary.error = result.error; break;
    }
    // Failed work has already received a backoff. Continue with other devices
    // instead of letting one unreachable or conflicting device stall the queue.
    if (result.state==='waiting_for_sessions') await sleep(1100);
  }
  return summary;
}

export async function reconcileInternetQueue(db, { env = process.env, runJob = processInternetJobs, jobOptions = {}, ...options } = {}) {
  let first = true;
  return drainInternetQueue(db, { env, maxCommands: 12, maxMs: 45000, ...options, runJob: (pool, settings) => {
    const audit = first; first = false;
    return runJob(pool, { ...settings, ...jobOptions, audit });
  } });
}

export function startsInternetWork(route, method) {
  return method==='POST' && (/^internet\/(redeem|grants)$/.test(route)
    || /^internet\/(sessions\/[^/]+\/actions|devices\/[^/]+\/access|requests\/[^/]+\/decision)$/.test(route));
}
