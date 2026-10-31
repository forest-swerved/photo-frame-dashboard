import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { ApiError, requireValue, uuidField } from './errors.js';
import { requireAdmin } from './auth.js';
import { one, transaction } from './database.js';
import { createMediaStorage } from './media-storage.js';
const bankLimit = 1_073_741_824;
const dto = row => ({ id: row.id, kind: row.kind, bytes: row.bytes, width: row.width, height: row.height, duration: row.duration, createdAt: row.created_at });
const store = options => options.storage || createMediaStorage(options.env);
export async function listMedia(db, principal) {
  return { media: (await db.query('SELECT * FROM family_media WHERE household_id=$1 AND ready ORDER BY created_at,id LIMIT 200', [principal.household.id])).rows.map(dto), maxBytes: bankLimit, maxItems: 200 };
}
export async function mediaContent(db, principal, id, options = {}) {
  uuidField(id);
  const row = await one(db, 'SELECT * FROM family_media WHERE id=$1 AND household_id=$2 AND ready', [id, principal.household.id]);
  requireValue(row, 404, 'not_found', 'This media is no longer in your family collection.');
  return store(options)('read-url', row.object_key);
}
export async function normalizePhoto(request) {
  requireValue(/^image\/(jpeg|png|webp)(?:;|$)/i.test(request.headers.get('content-type') || ''), 415, 'invalid_photo_type', 'Choose a JPEG, PNG or WebP photo.');
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 3_000_000) { await reader.cancel(); throw new ApiError(413, 'photo_too_large', 'Choose a photo under 3 MB.'); } chunks.push(value); }
  const input = Buffer.concat(chunks), fingerprint = createHash('sha256').update(input).digest('hex');
  try {
    const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning' }), metadata = await image.metadata();
    if (!['jpeg','png','webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error('format');
    const { data, info } = await image.rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#101621' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    requireValue(data.length <= 3_000_000, 413, 'photo_too_large', 'This photo is too complex. Choose a smaller copy.');
    return { data, fingerprint, width: info.width, height: info.height, bytes: data.length };
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(422, 'invalid_photo', 'This photo could not be read. Choose a different image.'); }
}
async function reserve(db, principal, id, item) {
  return transaction(db, async client => {
    // Serialize quota changes and household deletion. Pending uploads count too.
    const household = await one(client, 'SELECT id FROM family_households WHERE id=$1 FOR UPDATE', [principal.household.id]);
    requireValue(household, 404, 'not_found', 'This household is no longer available.');
    const existing = await one(client, 'SELECT * FROM family_media WHERE id=$1 AND household_id=$2', [id, principal.household.id]);
    if (existing) {
      requireValue(existing.fingerprint === item.fingerprint && existing.kind === item.kind, 409, 'media_conflict', 'This upload ID already belongs to another item.');
      return { row: existing, existing: true };
    }
    const usage = await one(client, `SELECT count(*)::integer AS count,coalesce(sum(CASE WHEN kind='video' AND NOT ready THEN 52428800 ELSE bytes END),0)::bigint AS bytes FROM family_media WHERE household_id=$1`, [principal.household.id]);
    const held = await one(client, 'SELECT coalesce(sum(reserved_bytes),0)::bigint AS bytes FROM family_media_cleanup WHERE object_key LIKE $1', [`${principal.household.id}/%`]);
    requireValue(usage.count < 200 && Number(usage.bytes) + Number(held.bytes) + (item.kind === 'video' ? 52428800 : item.bytes) <= bankLimit, 409, 'media_bank_full', 'Your collection has reached 200 items or 1 GB. Remove an item before adding more; recently removed uploads may need up to three hours to finish cleanup.');
    const cleanup = await one(client, 'SELECT count(*)::integer AS count FROM family_media_cleanup WHERE object_key LIKE $1', [`${principal.household.id}/%`]);
    requireValue(cleanup.count < 250, 429, 'media_upload_limit', 'Many uploads are being cleaned up. Try again later.');
    const key = `${principal.household.id}/${id}.${item.kind === 'photo' ? 'jpg' : 'mp4'}`;
    const row = await one(client, `INSERT INTO family_media(id,household_id,kind,object_key,fingerprint,bytes,width,height,duration)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, principal.household.id, item.kind, key, item.fingerprint, item.bytes, item.width, item.height, item.duration || null]);
    return { row, existing: false };
  });
}
export async function uploadPhoto(db, principal, id, request, options = {}) {
  requireAdmin(principal); uuidField(id);
  const item = await normalizePhoto(request), reservation = await reserve(db, principal, id, { ...item, kind: 'photo' });
  if (reservation.existing) {
    requireValue(reservation.row.ready, 409, 'upload_pending', 'This photo is still being processed. Refresh your collection.');
    return { media: dto(reservation.row) };
  }
  try {
    await store(options)('upload', reservation.row.object_key, item.data);
    const row = await one(db, 'UPDATE family_media SET ready=true WHERE id=$1 AND household_id=$2 RETURNING *', [id, principal.household.id]);
    requireValue(row, 409, 'upload_removed', 'This upload was removed.');
    return { media: dto(row) };
  } catch (error) {
    await db.query('DELETE FROM family_media WHERE id=$1 AND household_id=$2 AND NOT ready', [id, principal.household.id]);
    throw error;
  }
}
export async function reserveVideo(db, principal, id, body, options = {}) {
  requireAdmin(principal); uuidField(id);
  requireValue(Number.isSafeInteger(body.bytes) && body.bytes >= 16 && body.bytes <= 52428800 && Number.isFinite(body.duration) && body.duration > 0 && body.duration <= 300
    && [body.width,body.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1920) && /^[a-f0-9]{64}$/.test(body.fingerprint || ''), 422, 'invalid_video', 'Choose an MP4 video up to five minutes, 1080p and 50 MB.');
  const { row } = await reserve(db, principal, id, { ...body, kind: 'video' });
  if (row.ready) return { media: dto(row), uploadURL: null };
  requireValue(Date.now() - new Date(row.created_at).getTime() < 30 * 60_000, 409, 'upload_expired', 'This upload expired. Remove it and start again.');
  return { media: dto(row), uploadURL: (await store(options)('upload-url', row.object_key)).url };
}
export async function finishVideo(db, principal, id, options = {}) {
  requireAdmin(principal); uuidField(id);
  const row = await one(db, 'SELECT * FROM family_media WHERE id=$1 AND household_id=$2 AND kind=\'video\'', [id, principal.household.id]);
  requireValue(row, 404, 'not_found', 'This upload is no longer available.');
  if (row.ready) return { media: dto(row) };
  const result = await store(options)('inspect', row.object_key);
  requireValue(result.bytes === row.bytes, 422, 'video_size_mismatch', 'The uploaded video is incomplete. Remove it and try again.');
  const updated = await one(db, 'UPDATE family_media SET ready=true WHERE id=$1 AND household_id=$2 RETURNING *', [id, principal.household.id]);
  requireValue(updated, 409, 'upload_removed', 'This upload was removed.');
  return { media: dto(updated) };
}
export async function removeMedia(db, principal, id, options = {}) {
  requireAdmin(principal); uuidField(id);
  const row = await one(db, 'DELETE FROM family_media WHERE id=$1 AND household_id=$2 RETURNING object_key', [id, principal.household.id]);
  // Idempotent, with the same response for unknown and other-household IDs.
  if (row) { try { await store(options)('delete', row.object_key); } catch { /* Durable trigger retries after signed uploads expire. */ } }
  return { deleted: true };
}
export async function cleanupMedia(db, options = {}) {
  await db.query("DELETE FROM family_media WHERE NOT ready AND created_at<now()-interval '3 hours'");
  const rows = (await db.query('SELECT object_key FROM family_media_cleanup WHERE not_before<=now() ORDER BY not_before LIMIT 30')).rows;
  let removed = 0;
  for (const row of rows) {
    try { await store(options)('delete', row.object_key); await db.query('DELETE FROM family_media_cleanup WHERE object_key=$1', [row.object_key]); removed++; }
    catch { await db.query("UPDATE family_media_cleanup SET attempts=attempts+1,not_before=now()+interval '1 hour' WHERE object_key=$1", [row.object_key]); }
  }
  return { removed, attempted: rows.length };
}
