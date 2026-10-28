import { processInternetJobs } from './internet-worker.js';

// The committed queue remains the source of truth; this only removes the cron
// wait. Multiple kicks retain the same global command lease and version checks.
export async function drainInternetQueue(db, { env = process.env, runJob = processInternetJobs,
  clock = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve,ms)), maxCommands = 6, maxMs = 25000 } = {}) {
  const started = clock().getTime();
  for (let n=0;n<maxCommands && clock().getTime()-started<maxMs;n++) {
    const result = await runJob(db,{env,now:clock(),clock});
    if (!result.processed || result.state==='checking') return;
    if (result.state==='waiting_for_sessions') await sleep(1100);
  }
}

export function startsInternetWork(route, method) {
  return method==='POST' && (/^internet\/(redeem|grants)$/.test(route)
    || /^internet\/(sessions\/[^/]+\/actions|devices\/[^/]+\/access|requests\/[^/]+\/decision)$/.test(route));
}
