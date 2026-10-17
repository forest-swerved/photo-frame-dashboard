import { Worker } from 'node:worker_threads';
import { CalendarSyncError, createCalendarWindow, MAX_CALENDAR_EVENTS } from './calendar-normalize.js';

const MAX_BYTES = 8 * 1024 * 1024;
const NORMALIZE_TIMEOUT_MS = 5_000;

/**
 * A real CPU boundary: iterator.next() itself can loop on impossible imported
 * rules, so an outer occurrence counter cannot enforce a wall-clock deadline.
 * timeoutMs is injectable for fixtures, capped here; API callers never set it.
 */
export async function normalizeCalendarObjectsBounded(objects, options = {}) {
  const coverage = createCalendarWindow(options.window ?? options);
  const timeoutMs = options.timeoutMs ?? NORMALIZE_TIMEOUT_MS;
  const maxEvents = options.maxEvents ?? MAX_CALENDAR_EVENTS;
  const invalid = () => new CalendarSyncError('INVALID_CALENDAR_DATA', 'A calendar could not be read completely.', coverage);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NORMALIZE_TIMEOUT_MS
      || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_CALENDAR_EVENTS
      || !Array.isArray(objects) || objects.length > 1000) throw invalid();
  let bytes = 0;
  const input = objects.map((object) => {
    if (typeof object?.calendarId !== 'string' || !object.calendarId || object.calendarId.length > 128
        || typeof object.data !== 'string') throw invalid();
    const dataSize = Buffer.byteLength(object.data, 'utf8');
    const zone = object.calendarTimeZone ?? '';
    if (typeof zone !== 'string') throw invalid();
    const zoneSize = Buffer.byteLength(zone, 'utf8');
    bytes += dataSize + zoneSize;
    if (dataSize > 1024 * 1024 || zoneSize > 64 * 1024 || bytes > MAX_BYTES) throw invalid();
    return { calendarId: object.calendarId, data: object.data, calendarTimeZone: zone };
  });

  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    let timer;
    const failLimit = () => new CalendarSyncError('CALENDAR_WORK_LIMIT', 'A recurring calendar took too long to read completely.', coverage);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always terminate, including successful jobs and malformed worker output.
      Promise.resolve(worker?.terminate()).catch(() => {}).finally(() => {
        if (error) reject(error);
        else resolve(value);
      });
    };
    try {
      worker = new Worker(new URL('./calendar-normalize-worker.js', import.meta.url), {
        workerData: { objects: input, options: { window: coverage, maxEvents } },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
        execArgv: [],
      });
      // Startup/imports are separately bounded; a short test deadline starts
      // only after ready so it exercises expansion rather than startup timing.
      timer = setTimeout(() => finish(failLimit()), NORMALIZE_TIMEOUT_MS);
      worker.on('message', (message) => {
        if (settled) return;
        if (message?.type === 'started') {
          clearTimeout(timer);
          timer = setTimeout(() => finish(failLimit()), timeoutMs);
        } else if (message?.type === 'result' && Array.isArray(message.result?.events)
            && message.result.events.length <= maxEvents && message.result.coverage?.complete === true) {
          finish(null, message.result);
        } else if (message?.type === 'failure' && /^[A-Z_]+$/.test(message.error?.code ?? '')
            && typeof message.error.message === 'string') {
          finish(new CalendarSyncError(message.error.code, message.error.message, message.error.coverage ?? coverage));
        } else {
          finish(invalid());
        }
      });
      worker.on('error', () => finish(invalid()));
      worker.on('exit', () => { if (!settled) finish(invalid()); });
    } catch {
      finish(invalid());
    }
  });
}
