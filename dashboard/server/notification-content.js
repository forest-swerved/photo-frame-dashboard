import { digest } from './credentials.js';
import { Temporal } from '@js-temporal/polyfill';

const clean = (value, fallback = '', limit = 120) => Array.from(String(value || fallback).replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
const duration = value => {
  const minutes = Number.isFinite(Number(value)) ? Math.max(0, Math.ceil(Number(value))) : 0;
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours && `${hours} hour${hours === 1 ? '' : 's'}`, rest && `${rest} minute${rest === 1 ? '' : 's'}`].filter(Boolean).join(' ');
};
const preparationDuration = value => {
  const seconds = Math.max(0,Math.ceil(Number(value) || 0)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return [minutes && `${minutes} minute${minutes===1?'':'s'}`,rest && `${rest} second${rest===1?'':'s'}`].filter(Boolean).join(' ');
};
function time(value, timezone) {
  if (!value || !timezone) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
  } catch { return ''; }
}
export function notificationArtwork(kind, name = '') {
  const lower = name.toLowerCase();
  if (kind === 'console' && /\bps\s?5\b|playstation/.test(lower)) return 'ps5';
  if (kind === 'console' && lower.includes('switch')) return 'switch';
  if (kind === 'tablet' && /\bpro\b/.test(lower)) return 'tablet-pro';
  return { tablet:'tablet', phone:'phone', computer:'laptop', console:'console', tv:'apple-tv' }[kind] || 'other';
}

export function notificationContent(event) {
  const p = event.payload || {}, person = clean(p.personName, 'Your child', 70), device = clean(p.deviceName, 'Their device');
  const task = clean(p.title, 'A task'), actor = clean(p.actorName, 'A parent', 70), zone = p.timezone || event.timezone;
  const at = time(event.occurred_at || event.created_at, zone), end = time(p.endsAt, zone);
  let due = '';
  try { if(event.date && p.dueTime && zone) due = time(Temporal.PlainDateTime.from(`${event.date}T${p.dueTime}`).toZonedDateTime(zone).toInstant().toString(),zone); } catch { /* Older events can omit the dated deadline. */ }
  const granted = p.allDay ? 'All day' : p.indefinite ? 'Until a parent turns it off' : duration(p.minutes);
  const remaining = duration(p.usageRemainingSeconds / 60), prep = preparationDuration(p.preparationSeconds);
  const endText = end ? `This window ends at ${end}.` : 'Open Devices for the current deadline.';
  const reason = clean(p.reason, '', 180);
  const labels = {
    chore_completed: [`${person} finished a task`, task, `Marked done${at ? ` at ${at}` : ''}. Open Tasks to see today's progress.`],
    chore_submitted: [`${person} needs task approval`, task, `Submitted${at ? ` at ${at}` : ''}. Open Tasks to approve it or send it back.`],
    chore_reopened: [`${person}: task reopened`, task, 'This task needs to be done again. Open Tasks for the latest details.'],
    chore_due_soon: [`${person}: task due soon`, task, due ? `Due at ${due}. Open Tasks to mark it done.` : 'This task is due soon. Open Tasks to mark it done.'],
    chore_overdue: [`${person}: task still waiting`, task, 'Not marked done by its deadline. Open Tasks to review it.'],
    reward_earned: [`${person} earned ${duration(p.minutes) || 'device time'}`, 'All required tasks are complete', 'Choose a device now, or keep this reward saved for later.'],
    session_started: [`${person}'s device time started`, [device, granted, p.source==='reward' && 'earned'].filter(Boolean).join(' · '), `${prep ? `${prep} to get ready, then ${duration(p.minutes) || 'your device time'}. ` : ''}${endText}`],
    session_warning: [`${person}: ${remaining || 'a few minutes'} left`, device, `${endText} Finish up and save your progress.`],
    session_expired: [`${person}'s device time is up`, device, `This access window ended${at ? ` at ${at}` : ''}. Open Devices to see available time.`],
    session_paused: [`${person}'s device time paused`, device, `${remaining ? `${remaining} saved. ` : ''}This access window is paused${prep ? `, with ${prep} of get-ready time left` : ''}.`],
    session_ended: [`${person}'s device time ended`, device, `This access window was ended early${at ? ` at ${at}` : ''}. Open Devices for current access.`],
    session_adjusted: [`${person}'s device time ${p.action === 'resume' ? 'resumed' : 'updated'}`, device, p.paused ? `${remaining || 'The remaining time'} saved. The session is still paused.` : `${remaining ? `${remaining} remaining. ` : ''}${endText}`],
    enforcement_failed: [`${person}: device access needs attention`, device, 'The network has not confirmed this change. Open Devices to check before relying on it.'],
    access_requested: [`${person} requested device time`, [device, granted].filter(Boolean).join(' · '), reason ? `“${reason}” Open Devices to approve or decline.` : 'Open Devices to approve or decline this request.'],
    access_approved: [`${person}'s device request approved`, [device, granted].filter(Boolean).join(' · '), `${actor} approved the request. Network confirmation is pending.${reason ? ` ${reason}` : ''}`],
    access_declined: [`${person}'s device request declined`, device, `${actor} declined the request${granted ? ` for ${granted.toLowerCase()}` : ''}.`],
    access_granted: [`${person} ${p.additional ? 'got more device time' : 'was granted device time'}`, [device, granted, p.additional && 'added'].filter(Boolean).join(' · '), `${actor} granted ${person} ${p.indefinite ? 'Internet access' : p.allDay ? 'all-day access' : `${duration(p.minutes) || 'device time'}${p.additional ? ' additional' : ''} access`} to ${device}. Network confirmation is pending.`],
    daily_tasks_reminder: [`${person}: ${p.remaining || 'some'} task${p.remaining===1?'':'s'} left`, 'Your task list is ready', 'Open Tasks to see what is still waiting today.'],
    daily_tasks_completed: [`${person} finished today's tasks`, `${p.total || 'All'} task${p.total===1?'':'s'} complete`, 'Great work! Open Tasks to see the completed list.'],
    calendar_upcoming: ['Calendar reminder', task, 'This event starts soon.'],
    calendar_unavailable: ['Calendar needs attention', 'Sync is delayed', 'Your calendar has not synced recently. Check Apple Calendar in Settings.'],
    calendar_restored: ['Calendar is syncing again', '', 'Your shared calendar connection has recovered.'],
    frame_offline: ['Your frame may be offline', '', 'It has not checked in recently. Check its power and Wi-Fi.'],
    frame_online: ['Your frame is connected again', '', 'It is checking in with Family Frame.'],
  };
  const [title, subtitle, body] = labels[event.type] || ['Family update', '', 'Open Family Frame for the latest update.'];
  return { title:clean(title, '', 100), ...(subtitle ? { subtitle:clean(subtitle, '', 160) } : {}), body:clean(body, '', 400) };
}

export function notificationCategory(type) {
  if (type?.startsWith('chore_') || type?.startsWith('daily_tasks_')) return 'FAMILY_TASK';
  if (type === 'access_requested') return 'FAMILY_ACCESS_REQUEST';
  if (type === 'reward_earned') return 'FAMILY_REWARD';
  if (/^(session_|access_|enforcement_)/.test(type || '')) return 'FAMILY_INTERNET';
  return 'FAMILY_UPDATE';
}

export function notificationThread(event) {
  const category = notificationCategory(event.type);
  // Opaque, bounded thread keys: never put names or family identifiers on the lock screen.
  const context = [event.household_id, event.person_id, category,
    category === 'FAMILY_TASK' ? event.date || event.payload?.date : event.payload?.sessionId || event.payload?.deviceId];
  return `ff-${digest(JSON.stringify(context)).slice(0, 32)}`;
}

export function notificationPreviewPayload() {
  return { aps:{alert:{title:'Clearer family updates',subtitle:'Family Frame · Notification preview',
    body:'Device alerts show the child, device, time allowed and end time. Touch and hold to see the device picture and quick link.'},
    sound:'default',category:'FAMILY_PREVIEW','thread-id':'family-frame-preview','mutable-content':1},artwork:'tablet' };
}
