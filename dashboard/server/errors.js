export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requireValue(condition, status, code, message, details) {
  if (!condition) throw new ApiError(status, code, message, details);
}

export function json(data, status = 200, headers = {}) {
  return Response.json({ data }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export async function readJson(request) {
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'This request is too large.'); }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  requireValue(!size || /^application\/json(?:;|$)/i.test(request.headers.get('content-type') || ''), 415, 'content_type_required', 'Send this request as application/json.');
  let body;
  try { body = JSON.parse(text || '{}'); } catch { throw new ApiError(422, 'invalid_json', 'Send a valid JSON object.'); }
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 422, 'invalid_body', 'Send a JSON object.');
  return body;
}

export function textField(value, label, max = 160) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max,
    422, 'invalid_field', `${label} must contain 1–${max} characters.`);
  return value.trim();
}

export function versionField(value) {
  requireValue(Number.isSafeInteger(value) && value >= 0, 422, 'invalid_version', 'A valid expectedVersion is required.');
  return value;
}

export function dateField(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  422, 'invalid_date', 'Use a valid date in YYYY-MM-DD format.');
  return value;
}

export function uuidField(value, label = 'ID') {
  requireValue(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    422, 'invalid_id', `${label} is invalid.`);
  return value;
}

export function timezoneField(value) {
  const name = textField(value, 'Timezone', 80);
  try { new Intl.DateTimeFormat('en', { timeZone: name }).format(); }
  catch { throw new ApiError(422, 'invalid_timezone', 'Choose a valid timezone.'); }
  return name;
}

export function weekdaysField(value = [0, 1, 2, 3, 4, 5, 6]) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 7
    && value.every(day => Number.isInteger(day) && day >= 0 && day <= 6),
  422, 'invalid_weekdays', 'Choose at least one day of the week.');
  return [...new Set(value)].sort();
}

export function calendarWindow(from, to) {
  dateField(from); dateField(to);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  requireValue(days > 0 && days <= 60, 422, 'invalid_window', 'Choose a calendar window of 1–60 days.');
  return { startDate: from, endDateExclusive: to };
}

export function householdDate(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
