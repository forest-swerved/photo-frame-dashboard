import { parentPort, workerData } from 'node:worker_threads';
import { CalendarSyncError, normalizeCalendarObjects } from './calendar-normalize.js';

// Dedicated one-job worker: no credentials are sent here, and no raw ICS/errors
// are returned. The parent terminates the worker after every result or failure.
if (parentPort) {
  parentPort.postMessage({ type: 'started' });
  try {
    const result = normalizeCalendarObjects(workerData.objects, workerData.options);
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    const safe = error instanceof CalendarSyncError ? error
      : new CalendarSyncError('INVALID_CALENDAR_DATA', 'A calendar could not be read completely.');
    parentPort.postMessage({
      type: 'failure',
      error: { code: safe.code, message: safe.message, coverage: safe.coverage },
    });
  }
}
