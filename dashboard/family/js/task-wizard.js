import { request } from './api.js';
import { escapeHtml as h, mutationId, dateLabel } from './model.js';
import { routinePayload, schoolDayFilterLabel, taskSectionLabel } from './occurrences.js';

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function taskScheduleDraft(form) {
  const scheduleType = form.get('scheduleType'), weekdays = form.getAll('weekdays').map(Number);
  const schoolDayFilter = scheduleType === 'one_off' ? 'any' : form.get('schoolDayFilter');
  if (scheduleType === 'one_off' && !form.get('scheduledDate')) throw new Error('Choose the one-time date.');
  if (scheduleType === 'weekly' && !weekdays.length) throw new Error('Choose at least one repeat day.');
  return { title: String(form.get('title') || '').trim(), personIds: form.getAll('personIds'), scheduleType,
    scheduledDate: form.get('scheduledDate'), weekdays, schoolDayFilter,
    taskSection: scheduleType === 'weekly' && schoolDayFilter !== 'non_school_day' ? form.get('taskSection') : 'tasks' };
}
export function taskCreationPayload(form, operationId) {
  const personIds = form.getAll('personIds');
  if (!personIds.length) throw new Error('Choose at least one child.');
  const { personId, ...draft } = routinePayload(form);
  return { ...draft, personIds, mutationId: operationId };
}
export function taskScheduleSummary(draft) {
  if (draft.scheduleType === 'one_off') return `One time · ${dateLabel(draft.scheduledDate)}`;
  const selected = draft.weekdays;
  const repeat = selected.length === 7 ? 'Every day' : selected.length === 5 && selected.every(d => d > 0 && d < 6) ? 'Monday–Friday' : selected.map(d => days[d]).join(', ');
  const filter = draft.schoolDayFilter === 'any' ? 'School days and days off' : schoolDayFilterLabel(draft.schoolDayFilter);
  const section = draft.taskSection === 'tasks' ? 'Any time' : `${taskSectionLabel(draft.taskSection)}${draft.schoolDayFilter === 'any' ? ' on school days; Tasks on days off' : ''}`;
  return `${repeat} · ${draft.schoolDayFilter === 'any' && draft.taskSection !== 'tasks' ? '' : `${filter} · `}${section}`;
}

export function openTaskWizard(ctx, { personId = '', schoolDayFilter = 'any', taskSection = 'tasks' } = {}) {
  const people = ctx.snapshot()?.people || [], operationId = mutationId(), started = ctx.epoch();
  const choice = (label, name, checked) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span>${h(label)}</span></label>`;
  ctx.openDialog('Add a task', `<div class="task-wizard">
    <p class="wizard-progress" aria-live="polite" data-wizard-progress>Step 1 of 3 · Task & children</p>
    <section data-wizard-step="0"><h3>What needs doing?</h3>${ctx.field('Task', 'title', '', { max: 100 })}
      <fieldset class="wizard-children"><legend>Who is it for?</legend>${people.map(p => `<label class="wizard-choice"><input type="checkbox" name="personIds" value="${h(p.id)}" ${personId === p.id ? 'checked' : ''}><span>${h(p.name)}</span></label>`).join('')}</fieldset>
      ${people.length > 1 ? '<button type="button" class="text-button" data-all-children>Select all children</button>' : ''}
      <p class="field-help">Each selected child gets their own task to check off.</p></section>
    <section data-wizard-step="1" hidden><h3>When should it happen?</h3>
      <label class="field"><span>Schedule</span><select name="scheduleType" aria-label="Schedule"><option value="weekly">Recurring task</option><option value="one_off">One time</option></select></label>
      <div data-one-time hidden>${ctx.field('One-off date', 'scheduledDate', ctx.today(), { type: 'date' })}</div>
      <div data-repeating><label class="field"><span>Day type</span><select name="schoolDayFilter" aria-label="Day type"><option value="any" ${schoolDayFilter === 'any' ? 'selected' : ''}>School days and days off</option><option value="school_day" ${schoolDayFilter === 'school_day' ? 'selected' : ''}>School days only</option><option value="non_school_day" ${schoolDayFilter === 'non_school_day' ? 'selected' : ''}>Days off only</option></select></label>
        <label class="field" data-section-field><span>On school days</span><select name="taskSection" aria-label="On school days"><option value="tasks" ${taskSection === 'tasks' ? 'selected' : ''}>Any time</option><option value="before_school" ${taskSection === 'before_school' ? 'selected' : ''}>Before school</option><option value="after_school" ${taskSection === 'after_school' ? 'selected' : ''}>After school</option></select></label>
        <fieldset class="weekday-picker"><legend>Repeat days</legend>${days.map((d, n) => `<label><input type="checkbox" name="weekdays" value="${n}" checked><span>${d}</span></label>`).join('')}</fieldset>
        <div class="wizard-presets" role="group" aria-label="Repeat day shortcuts"><button type="button" class="text-button" data-days="all">Every day</button><button type="button" class="text-button" data-days="weekdays">Weekdays</button><button type="button" class="text-button" data-days="weekends">Weekends</button></div>
        <p class="field-help">The school calendar checks the repeat days you choose. Days off always show tasks in one Tasks list.</p></div></section>
    <section data-wizard-step="2" hidden><h3>Ready to add?</h3><div class="wizard-review" data-wizard-review></div>
      ${choice('Required before earned device time', 'required', true)}${choice('A parent must approve completion', 'requiresApproval', false)}
      <details class="advanced-fields"><summary>Instructions & checklist</summary><label class="field"><span>Instructions</span><textarea name="instructions" maxlength="3000" rows="3"></textarea></label><label class="field"><span>Steps · one per line, up to 20</span><textarea name="subtasks" maxlength="3400" rows="3"></textarea></label></details>
      <details class="advanced-fields"><summary>Deadline & reminders</summary>${ctx.field('Due by (optional)', 'dueTime', '', { type: 'time', required: false })}<label class="field"><span>Early reminder</span><select name="reminderMinutes" aria-label="Early reminder">${[0, 5, 15, 30, 60].map(n => `<option value="${n}" ${n === 15 ? 'selected' : ''}>${n ? `${n} minutes before` : 'No early reminder'}</option>`).join('')}</select></label><p class="field-help">Times follow ${h(ctx.zone())}.</p></details>
    </section><p class="form-error" data-wizard-error role="alert" hidden></p>
    <div class="dialog-actions"><button type="button" class="text-button" data-wizard-back hidden>Back</button><button type="button" class="button" data-wizard-next>Continue</button><button type="submit" class="button" data-wizard-save hidden>Add task</button></div></div>`, async (form, element) => {
    if (step < 2) { advance(); return; }
    const payload = taskCreationPayload(form, operationId);
    try { await request('/api/chores/batch', { method: 'POST', body: payload }); }
    catch (error) {
      if (error.status === 0 || error.status >= 500 || error.status === 409) { element.dataset.reviewRequired = 'true'; throw new Error('This save needs review. Refresh your tasks before adding it again.'); }
      throw error;
    }
    if (started !== ctx.epoch()) return;
    if (ctx.dialog.open && ctx.dialog.querySelector('form') === element) ctx.dialog.close();
    ctx.toast(payload.personIds.length > 1 ? 'Tasks added for each child.' : 'Task added.'); await ctx.reload();
  });
  const form = ctx.dialog.querySelector('form'); form.noValidate = true;
  let step = 0;
  const error = ctx.dialog.querySelector('[data-wizard-error]');
  const values = () => new FormData(form);
  function valid() {
    if (step === 0) {
      const title = form.elements.title;
      if (!title.value.trim()) { error.textContent = 'Give the task a name.'; title.focus(); return false; }
      if (!values().getAll('personIds').length) { error.textContent = 'Choose at least one child.'; return false; }
    }
    if (step === 1) { try { taskScheduleDraft(values()); } catch (e) { error.textContent = e.message; return false; } }
    return true;
  }
  function show() {
    error.hidden = true;
    ctx.dialog.querySelectorAll('[data-wizard-step]').forEach(s => { s.hidden = Number(s.dataset.wizardStep) !== step; });
    ctx.dialog.querySelector('[data-wizard-progress]').textContent = `Step ${step + 1} of 3 · ${['Task & children', 'Schedule', 'Review'][step]}`;
    ctx.dialog.querySelector('[data-wizard-back]').hidden = step === 0;
    ctx.dialog.querySelector('[data-wizard-next]').hidden = step === 2;
    ctx.dialog.querySelector('[data-wizard-save]').hidden = step !== 2;
    if (step === 2) { const draft = taskScheduleDraft(values()); ctx.dialog.querySelector('[data-wizard-review]').innerHTML = `<strong>${h(draft.title)}</strong><p>${h(people.filter(p => draft.personIds.includes(p.id)).map(p => p.name).join(' & '))}</p><p>${h(taskScheduleSummary(draft))}</p>`; }
    const body = ctx.dialog.querySelector('.dialog-body'); body.scrollTop = 0;
    const active = ctx.dialog.querySelector(`[data-wizard-step="${step}"]`); (active.querySelector('input,select,textarea') || active).focus();
  }
  function advance() { if (!valid()) { error.hidden = false; return; } step = Math.min(2, step + 1); show(); }
  function scheduleVisibility() { const recurring = form.elements.scheduleType.value === 'weekly'; ctx.dialog.querySelector('[data-one-time]').hidden = recurring; ctx.dialog.querySelector('[data-repeating]').hidden = !recurring; ctx.dialog.querySelector('[data-section-field]').hidden = form.elements.schoolDayFilter.value === 'non_school_day'; form.querySelectorAll('.wizard-choice').forEach(label => label.classList.toggle('selected', label.querySelector('input').checked)); }
  ctx.dialog.querySelector('[data-wizard-next]').onclick = advance;
  ctx.dialog.querySelector('[data-wizard-back]').onclick = () => { step--; show(); };
  ctx.dialog.querySelector('[data-all-children]')?.addEventListener('click', () => form.querySelectorAll('[name="personIds"]').forEach(c => { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }));
  form.addEventListener('change', scheduleVisibility);
  ctx.dialog.querySelectorAll('[data-days]').forEach(b => { b.onclick = () => form.querySelectorAll('[name="weekdays"]').forEach(c => { const n = Number(c.value); c.checked = b.dataset.days === 'all' || (b.dataset.days === 'weekdays' ? n > 0 && n < 6 : n === 0 || n === 6); c.dispatchEvent(new Event('change', { bubbles: true })); }); });
  scheduleVisibility();
}
