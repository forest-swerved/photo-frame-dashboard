import { request } from './api.js';
import { escapeHtml as h, dateLabel, addDays } from './model.js';
import { schoolDayStatus } from './occurrences.js';

const rangeLabel = (from, to) => `${dateLabel(from, { weekday: undefined, month: 'short', day: 'numeric', year: 'numeric' })} – ${dateLabel(addDays(to, -1), { weekday: undefined, month: 'short', day: 'numeric', year: 'numeric' })}`;

function sourceLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? `<p class="supporting"><a class="text-button" href="${h(url.href)}" target="_blank" rel="noopener noreferrer">School calendar source ↗</a></p>` : '';
  } catch { return ''; }
}

export function createSchoolCalendarUI(ctx) {
  const manager = () => ctx.session()?.role === 'admin' || ctx.snapshot()?.capabilities?.manageChores === true;
  function panel() {
    if (!manager()) return '';
    return `<section class="panel setup-card school-calendar-card" data-key="school-calendar-card"><p class="eyebrow">School & home</p><h2>School calendar</h2>${schoolDayStatus(ctx.snapshot())}<p class="supporting">School days and days off can have different task routines. Review the imported calendar and manage parent date changes here.</p>${ctx.button('View school calendar', 'school-calendar', 'button button-secondary')}</section>`;
  }
  async function open() {
    if (!manager()) return;
    const started = ctx.epoch();
    const data = await request(`/api/school-calendar?date=${encodeURIComponent(ctx.today())}`);
    if (started !== ctx.epoch() || ctx.dialog.open) return;
    const calendar = data.calendar;
    if (!calendar) {
      ctx.openDialog('School calendar', '<p class="supporting">No school calendar has been imported yet. School-specific tasks wait until the date is confirmed. Any-day tasks still apply.</p>', async () => {});
      return;
    }
    const closures = calendar.closures || [], overrides = calendar.overrides || [];
    const todayOverride = overrides.find(item => item.date === ctx.today());
    ctx.openDialog('School calendar', `<div class="school-calendar-summary"><h3>${h(calendar.title)}</h3><p class="supporting">Imported from ${h(calendar.sourceName || 'your school calendar')}</p><dl class="school-calendar-facts"><div><dt>School term</dt><dd>${h(rangeLabel(calendar.termStart, calendar.termEndExclusive))}</dd></div><div><dt>Confirmed calendar dates</dt><dd>${h(rangeLabel(calendar.coverageStart, calendar.coverageEndExclusive))}</dd></div></dl>${schoolDayStatus({ schoolDay: data.schoolDay })}<details class="school-calendar-dates"><summary>Scheduled days off (${closures.length})</summary>${closures.length ? `<ul>${closures.map(item => `<li><strong>${h(item.label)}</strong><span>${h(rangeLabel(item.fromDate, item.toDateExclusive))}</span></li>`).join('')}</ul>` : '<p class="quiet-empty">No scheduled closures in this calendar.</p>'}</details><details class="school-calendar-dates"><summary>Parent date changes (${overrides.length})</summary>${overrides.length ? `<ul>${overrides.map(item => `<li><strong>${h(dateLabel(item.date))} · ${item.type === 'school_day' ? 'School day' : 'No school'}</strong><span>${h(item.reason)}</span></li>`).join('')}</ul>` : '<p class="quiet-empty">No parent date changes.</p>'}</details></div><div class="form-stack school-calendar-override"><h3>Change one day</h3><p class="field-help">Choose the day type for today or a future date, or restore the imported schedule. This switches school-day and non-school-day tasks. Completed work and pending approvals stay in the history.</p>${ctx.field('School date', 'schoolDate', ctx.today(), { type: 'date', extra: `min="${h(calendar.coverageStart > ctx.today() ? calendar.coverageStart : ctx.today())}" max="${h(addDays(calendar.coverageEndExclusive, -1))}"` })}<label class="field"><span>Day type</span><select name="schoolDayType" aria-label="Day type"><option value="non_school_day" ${todayOverride?.type !== 'school_day' ? 'selected' : ''}>No school</option><option value="school_day" ${todayOverride?.type === 'school_day' ? 'selected' : ''}>School day</option><option value="clear">Use imported calendar</option></select></label>${ctx.field('Reason for date change', 'schoolReason', todayOverride?.reason || '', { max: 500 })}<button type="submit" class="button">Save school date</button></div>`, async (form, element) => {
      const type = form.get('schoolDayType');
      try {
        await request('/api/school-calendar', { method: 'PATCH', body: { expectedVersion: calendar.version, override: {
          date: form.get('schoolDate'), type: type === 'clear' ? null : type, reason: String(form.get('schoolReason') || '').trim(),
        } } });
      } catch (error) {
        if (error.status === 0 || error.status >= 500 || error.status === 409) {
          element.dataset.reviewRequired = 'true';
          throw new Error('This calendar change needs review. Close this editor and reopen the school calendar before trying again.');
        }
        throw error;
      }
      if (started !== ctx.epoch()) return;
      if (ctx.dialog.querySelector('form') === element) ctx.dialog.close();
      ctx.toast('School calendar date saved.'); await ctx.reload();
    });
    let previewRequest = 0;
    const preview = document.createElement('div');
    preview.dataset.schoolDatePreview = ''; preview.setAttribute('aria-live', 'polite');
    ctx.dialog.querySelector('[name="schoolDate"]').closest('.field').after(preview);
    ctx.dialog.querySelector('.school-calendar-summary .supporting').insertAdjacentHTML('afterend', sourceLink(calendar.sourceUrl));
    ctx.dialog.querySelector('[name="schoolDate"]').onchange = async event => {
      const existing = overrides.find(item => item.date === event.target.value);
      ctx.dialog.querySelector('[name="schoolReason"]').value = existing?.reason || '';
      ctx.dialog.querySelector('[name="schoolDayType"]').value = existing?.type || 'non_school_day';
      const sequence = ++previewRequest;
      if (!event.target.value) { preview.textContent = ''; return; }
      preview.textContent = 'Checking this school date…';
      try {
        const result = await request(`/api/school-calendar?date=${encodeURIComponent(event.target.value)}`);
        if (sequence !== previewRequest || started !== ctx.epoch() || !preview.isConnected) return;
        preview.innerHTML = schoolDayStatus({ schoolDay: result.schoolDay });
      } catch (error) {
        if (sequence === previewRequest && preview.isConnected) preview.textContent = error.message;
      }
    };
  }
  return { panel, open };
}
