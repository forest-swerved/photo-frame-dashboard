import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';

export const MAX_CALENDAR_DAYS = 60;
export const MAX_CALENDAR_EVENTS = 400;
const MAX_OCCURRENCE_STEPS = 20_000;
const MAX_OBJECTS = 1_000;
const MAX_ICAL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;

// Only these sanitized errors may cross the server/API boundary. Never attach a
// provider response, DAV URL, raw ICS, credentials, or the original error cause.
export class CalendarSyncError extends Error {
  constructor(code, message, coverage = null) {
    super(message);
    this.name = 'CalendarSyncError';
    this.code = code;
    if (coverage) this.coverage = { ...coverage, complete: false };
  }
}

function invalidData() {
  return new CalendarSyncError('INVALID_CALENDAR_DATA', 'A calendar could not be read completely.');
}

function plainDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date');
  return Temporal.PlainDate.from(value, { overflow: 'reject' });
}

export function createCalendarWindow({
  startDate, endDateExclusive, timeZone = 'America/Denver', days = 30, now = new Date(),
} = {}) {
  try {
    if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error('zone');
    // Validate against the runtime's IANA database, including supported aliases.
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
    let start;
    let end;
    if (startDate !== undefined || endDateExclusive !== undefined) {
      start = plainDate(startDate);
      end = plainDate(endDateExclusive);
    } else {
      if (![30, 60].includes(days)) throw new Error('days');
      const instant = Temporal.Instant.from(new Date(now).toISOString());
      start = instant.toZonedDateTimeISO(timeZone).toPlainDate();
      end = start.add({ days });
    }
    const length = start.until(end, { largestUnit: 'days' }).days;
    if (length < 1 || length > MAX_CALENDAR_DAYS) throw new Error('range');
    const asInstant = (date) => new Date(date.toZonedDateTime({
      timeZone, plainTime: '00:00',
    }).epochMilliseconds).toISOString();
    return {
      start: asInstant(start), end: asInstant(end),
      startDate: start.toString(), endDateExclusive: end.toString(), timeZone,
      complete: true, truncated: false, warnings: [],
    };
  } catch {
    throw new CalendarSyncError('INVALID_CALENDAR_WINDOW', 'Choose a valid calendar time zone and a date range of at most 60 days.');
  }
}

function isoDate(time) {
  return `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function epoch(time, timeZone) {
  if (!(time instanceof ICAL.Time) || time.isDate) throw invalidData();
  if (time.zone === ICAL.Timezone.localTimezone || time.zone?.tzid === 'floating') {
    // Never use ICAL's toJSDate() on floating time: it uses the server's TZ.
    return Temporal.ZonedDateTime.from({
      timeZone, year: time.year, month: time.month, day: time.day,
      hour: time.hour, minute: time.minute, second: time.second,
    }, { overflow: 'reject', disambiguation: 'compatible' }).epochMilliseconds;
  }
  const result = time.toUnixTime() * 1000;
  if (!Number.isFinite(result)) throw invalidData();
  return result;
}

function occurrenceKey(time, timeZone) {
  return time.isDate ? `date:${isoDate(time)}` : `time:${epoch(time, timeZone)}`;
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maxLength);
}

function addIanaFallback(root) {
  const componentLookup = root.getTimeZoneByID.bind(root);
  const zones = new Map();
  // A per-document fallback keeps user VTIMEZONE definitions isolated. Valid
  // IANA TZIDs without VTIMEZONE use Temporal/ICU, never the server's local TZ.
  root.getTimeZoneByID = (tzid) => {
    const defined = componentLookup(tzid);
    if (defined) return defined;
    if (['UTC', 'GMT', 'Z'].includes(tzid)) return ICAL.Timezone.utcTimezone;
    if (zones.has(tzid)) return zones.get(tzid);
    try {
      new Intl.DateTimeFormat('en', { timeZone: tzid }).format(0);
      const zone = new ICAL.Timezone({ tzid });
      zone.utcOffset = (time) => {
        const fields = {
          year: time.year, month: time.month, day: time.day,
          hour: time.hour, minute: time.minute, second: time.second,
        };
        const wall = Temporal.PlainDateTime.from(fields, { overflow: 'reject' });
        const instant = wall.toZonedDateTime(tzid, { disambiguation: 'compatible' });
        // For a DST gap, use the pre-transition offset as RFC 5545 requires.
        // instant.offset alone would instead describe the shifted valid time.
        return (wall.toZonedDateTime('UTC').epochMilliseconds - instant.epochMilliseconds) / 1000;
      };
      zones.set(tzid, zone);
      return zone;
    } catch {
      return null;
    }
  };
}

function addCollectionTimeZones(root, value) {
  if (!value) return;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024) throw invalidData();
  const definition = new ICAL.Component(ICAL.parse(value));
  const zones = definition.name === 'vtimezone' ? [definition]
    : definition.name === 'vcalendar' ? definition.getAllSubcomponents('vtimezone') : [];
  if (!zones.length) throw invalidData();
  for (const zone of zones) {
    const tzid = zone.getFirstPropertyValue('tzid');
    if (!tzid) throw invalidData();
    // Resource-specific definitions always take precedence over collection data.
    if (!root.getTimeZoneByID(tzid)) root.addSubcomponent(zone);
  }
}

function validateTimeZoneDefinitions(root) {
  for (const zone of root.getAllSubcomponents('vtimezone')) {
    const tzid = zone.getFirstPropertyValue('tzid');
    const transitions = [...zone.getAllSubcomponents('standard'), ...zone.getAllSubcomponents('daylight')];
    if (typeof tzid !== 'string' || !tzid || tzid.length > 200 || !transitions.length) throw invalidData();
    for (const transition of transitions) {
      if (!(transition.getFirstPropertyValue('dtstart') instanceof ICAL.Time)) throw invalidData();
      for (const name of ['tzoffsetfrom', 'tzoffsetto']) {
        const offset = transition.getFirstPropertyValue(name);
        if (!offset || !Number.isFinite(offset.toSeconds?.()) || Math.abs(offset.toSeconds()) >= 86_400) throw invalidData();
      }
    }
  }
}

function validateTimes(component) {
  for (const name of ['dtstart', 'dtend', 'recurrence-id', 'rdate', 'exdate']) {
    for (const property of component.getAllProperties(name)) {
      if (property.type === 'period') {
        throw new CalendarSyncError('UNSUPPORTED_CALENDAR_DATA', 'A calendar contains an unsupported recurrence format.');
      }
      const tzid = property.getParameter('tzid');
      if (tzid && !['UTC', 'GMT', 'Z'].includes(tzid) && !component.getTimeZoneByID(tzid)) {
        // ICAL otherwise silently converts a missing TZID definition to floating.
        throw new CalendarSyncError('UNSUPPORTED_CALENDAR_TIME_ZONE', 'A calendar is missing a required time zone definition.');
      }
      for (const raw of property.toJSON().slice(3)) {
        if (typeof raw !== 'string') throw invalidData();
        Temporal.PlainDateTime.from(raw.replace(/Z$/, ''), { overflow: 'reject' });
      }
      for (const time of property.getValues()) {
        if (!(time instanceof ICAL.Time)) throw invalidData();
        if (time.isDate) plainDate(isoDate(time));
      }
    }
  }
  if (component.hasProperty('exrule')) {
    throw new CalendarSyncError('UNSUPPORTED_CALENDAR_DATA', 'A calendar contains an unsupported recurrence format.');
  }
}

function isCancelled(event) {
  return String(event.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function selectVersion(previous, next) {
  if (!previous || previous.component.toString() === next.component.toString()) return next;
  const version = (event) => {
    const seq = Number(event.component.getFirstPropertyValue('sequence') ?? 0);
    const stamp = event.component.getFirstPropertyValue('dtstamp');
    return [Number.isFinite(seq) ? seq : 0, stamp instanceof ICAL.Time ? stamp.toUnixTime() : 0];
  };
  const a = version(previous);
  const b = version(next);
  if (a[0] !== b[0]) return a[0] > b[0] ? previous : next;
  if (a[1] !== b[1]) return a[1] > b[1] ? previous : next;
  // Two conflicting versions without an ordering must not look like a full sync.
  throw invalidData();
}

function allDayEnd(event, start) {
  const baseStart = event.startDate;
  const explicitEnd = event.component.getFirstPropertyValue('dtend');
  const duration = event.component.getFirstPropertyValue('duration');
  let days = 1;
  if (explicitEnd) {
    if (!explicitEnd.isDate) throw invalidData();
    days = plainDate(isoDate(baseStart)).until(plainDate(isoDate(explicitEnd)), { largestUnit: 'days' }).days;
  } else if (duration) {
    if (duration.isNegative || duration.hours || duration.minutes || duration.seconds) throw invalidData();
    days = duration.weeks * 7 + duration.days;
  }
  if (days < 1) throw invalidData();
  return plainDate(isoDate(start)).add({ days }).toString();
}

function timedEnd(event, start, timeZone) {
  const startAt = epoch(start, timeZone);
  const explicitEnd = event.component.getFirstPropertyValue('dtend');
  if (explicitEnd) {
    if (explicitEnd.isDate) throw invalidData();
    // RFC 5545: a DTEND-defined recurrence preserves the exact initial duration.
    const elapsed = epoch(explicitEnd, timeZone) - epoch(event.startDate, timeZone);
    if (elapsed < 0) throw invalidData();
    return startAt + elapsed;
  }
  const duration = event.component.getFirstPropertyValue('duration');
  if (!duration) return startAt;
  if (duration.isNegative) throw invalidData();
  // Nominal calendar days/weeks first, then exact clock seconds (DST matters).
  const dayEnd = start.clone();
  dayEnd.addDuration(ICAL.Duration.fromData({ days: duration.days, weeks: duration.weeks }));
  return epoch(dayEnd, timeZone) + (duration.hours * 3600 + duration.minutes * 60 + duration.seconds) * 1000;
}

/** Normalize private DAV objects without returning raw ICS, DAV URLs, or UIDs. */
export function normalizeCalendarObjects(objects, options = {}) {
  const coverage = createCalendarWindow(options.window ?? options);
  const maxEvents = Math.min(options.maxEvents ?? MAX_CALENDAR_EVENTS, MAX_CALENDAR_EVENTS);
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw invalidData();
  const startEpoch = Date.parse(coverage.start);
  const endEpoch = Date.parse(coverage.end);
  const groups = new Map();
  const events = new Map();
  let bytes = 0;
  let components = 0;
  let steps = 0;
  const step = () => {
    if (++steps > MAX_OCCURRENCE_STEPS) {
      throw new CalendarSyncError('CALENDAR_WORK_LIMIT', 'A recurring calendar is too large to read completely.', coverage);
    }
  };
  try {
    if (!Array.isArray(objects) || objects.length > MAX_OBJECTS) throw invalidData();
    for (const object of objects) {
      if (typeof object?.calendarId !== 'string' || !object.calendarId || object.calendarId.length > 128 || typeof object.data !== 'string') throw invalidData();
      bytes += Buffer.byteLength(object.data, 'utf8');
      if (bytes > MAX_ICAL_BYTES || Buffer.byteLength(object.data, 'utf8') > 1024 * 1024) throw invalidData();
      const root = new ICAL.Component(ICAL.parse(object.data));
      if (root.name !== 'vcalendar') throw invalidData();
      addCollectionTimeZones(root, object.calendarTimeZone);
      validateTimeZoneDefinitions(root);
      addIanaFallback(root);
      for (const component of root.getAllSubcomponents('vevent')) {
        if (++components > 2_000) throw invalidData();
        validateTimes(component);
        // Explicit exception lists prevent accidental association with other UIDs.
        const event = new ICAL.Event(component, { exceptions: [], strictExceptions: true });
        if (!event.uid || String(event.uid).length > 1024) throw invalidData();
        if (!isCancelled(event) && !(event.startDate instanceof ICAL.Time)) throw invalidData();
        const key = `${object.calendarId}\0${event.uid}`;
        const group = groups.get(key) ?? { calendarId: object.calendarId, uid: event.uid, master: null, overrides: new Map() };
        if (event.isRecurrenceException()) {
          const id = occurrenceKey(event.recurrenceId, coverage.timeZone);
          group.overrides.set(id, selectVersion(group.overrides.get(id), event));
        } else {
          group.master = selectVersion(group.master, event);
        }
        groups.set(key, group);
      }
    }

    const emit = (group, item, start, recurrenceId) => {
      if (isCancelled(item)) return;
      if (!(start instanceof ICAL.Time)) throw invalidData();
      const id = createHash('sha256').update(`${group.calendarId}\0${group.uid}\0${occurrenceKey(recurrenceId ?? start, coverage.timeZone)}`).digest('hex');
      const common = {
        id, calendarId: group.calendarId,
        title: cleanText(item.summary || 'Untitled event', 240),
        location: cleanText(item.location, 300), allDay: start.isDate,
      };
      let normalized;
      if (start.isDate) {
        const startDate = isoDate(start);
        const endDateExclusive = allDayEnd(item, start);
        if (startDate >= coverage.endDateExclusive || endDateExclusive <= coverage.startDate) return;
        normalized = { ...common, startDate, endDateExclusive };
      } else {
        const from = epoch(start, coverage.timeZone);
        const to = timedEnd(item, start, coverage.timeZone);
        if (from >= endEpoch || (to > from ? to <= startEpoch : from < startEpoch)) return;
        const sourceZone = start.zone?.tzid;
        normalized = {
          ...common, startAt: new Date(from).toISOString(), endAt: new Date(to).toISOString(),
          timeZone: sourceZone && sourceZone !== 'floating' ? sourceZone : coverage.timeZone,
        };
      }
      events.set(id, normalized);
      if (events.size > maxEvents) {
        throw new CalendarSyncError('CALENDAR_EVENT_LIMIT', 'This calendar window contains more than 400 events. Choose fewer calendars or a shorter window.', { ...coverage, truncated: true });
      }
    };

    for (const group of groups.values()) {
      const master = group.master;
      if (master && isCancelled(master)) continue;
      if (master) {
        let maxBackwardShift = 0;
        for (const override of group.overrides.values()) {
          if (!isCancelled(override)) master.relateException(override);
          if (!isCancelled(override) && override.modifiesFuture()) {
            maxBackwardShift = Math.max(maxBackwardShift, override.recurrenceId.subtractDate(override.startDate).toSeconds() * 1000);
          }
        }
        if (master.isRecurring()) {
          const iterator = master.iterator();
          const rangeOverrides = [...group.overrides.values()]
            .filter((item) => item.modifiesFuture())
            .sort((a, b) => a.recurrenceId.compare(b.recurrenceId));
          const emitOccurrence = (next) => {
            const key = occurrenceKey(next, coverage.timeZone);
            const direct = group.overrides.get(key);
            const details = master.getOccurrenceDetails(next);
            const activeRange = rangeOverrides.findLast((item) => item.recurrenceId.compare(next) <= 0);
            // Explicit lookup also handles equivalent recurrence IDs in other zones.
            const item = direct ?? details.item;
            if (!(activeRange && isCancelled(activeRange) && !direct) && !isCancelled(item)) {
              emit(group, item, direct ? direct.startDate : details.startDate, next);
            }
          };
          // ICAL's RDATE-only iterator does not include DTSTART. RFC 5545's
          // recurrence set does, unless EXDATE explicitly excludes it.
          const excludedStart = master.component.getAllProperties('exdate').some((property) => property.getValues().some((date) => (
            date.isDate ? isoDate(date) === isoDate(master.startDate)
              : occurrenceKey(date, coverage.timeZone) === occurrenceKey(master.startDate, coverage.timeZone)
          )));
          if (!excludedStart) emitOccurrence(master.startDate);
          let next;
          while ((next = iterator.next())) {
            step();
            emitOccurrence(next);
            const original = next.isDate
              ? Date.parse(`${isoDate(next)}T00:00:00Z`)
              : epoch(next, coverage.timeZone);
            if (original >= endEpoch + maxBackwardShift + 2 * DAY_MS) break;
          }
        } else {
          const direct = group.overrides.get(occurrenceKey(master.startDate, coverage.timeZone));
          if (!direct) emit(group, master, master.startDate, master.startDate);
        }
      }
      // A changed occurrence may move INTO the window from any original date.
      // This also supports provider-expanded resources with no master component.
      for (const override of group.overrides.values()) {
        step();
        if (!isCancelled(override)) emit(group, override, override.startDate, override.recurrenceId);
      }
    }
    return {
      events: [...events.values()].sort((a, b) => {
        const aStart = a.allDay ? `${a.startDate}T00:00:00` : a.startAt;
        const bStart = b.allDay ? `${b.startDate}T00:00:00` : b.startAt;
        return aStart.localeCompare(bStart) || a.id.localeCompare(b.id);
      }), coverage,
    };
  } catch (error) {
    if (error instanceof CalendarSyncError) {
      if (!error.coverage) error.coverage = { ...coverage, complete: false };
      throw error;
    }
    throw new CalendarSyncError('INVALID_CALENDAR_DATA', 'A calendar could not be read completely.', coverage);
  }
}
