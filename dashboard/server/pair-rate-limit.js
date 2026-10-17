import { isIP } from 'node:net';
import { keyedDigest } from './credentials.js';
import { one, transaction } from './database.js';
import { requireValue } from './errors.js';

export function trustedClientIp(request, env = process.env) {
  if (env.VERCEL !== '1') return 'local';
  // Vercel supplies this version even when another proxy overwrites X-Forwarded-For.
  // https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
  const value = request.headers.get('x-vercel-forwarded-for')?.trim();
  return value && isIP(value) ? value : 'unknown';
}

export async function enforcePairRateLimit(db, request, env = process.env) {
  const ipBucket = `pair:ip:${keyedDigest('pair-client-ip', trustedClientIp(request, env), env)}`;
  const allowed = await transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('family-pair-rate-limit',0))");
    await client.query("DELETE FROM family_rate_limits WHERE window_start<now()-interval '10 minutes'");
    const increment = async bucket => one(client, `INSERT INTO family_rate_limits(bucket_key,window_start,attempts)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(bucket_key) DO UPDATE SET
      attempts=CASE WHEN family_rate_limits.window_start=date_trunc('minute',now()) THEN family_rate_limits.attempts+1 ELSE 1 END,
      window_start=date_trunc('minute',now()) RETURNING attempts`, [bucket]);
    const global = await increment('pair:global');
    if (global.attempts > 30) return false;
    return (await increment(ipBucket)).attempts <= 5;
  });
  // Reject after commit: otherwise a rejected request could undo its own attempt.
  requireValue(allowed, 429, 'pair_rate_limited', 'Too many pairing attempts. Wait a minute and try again.');
}
