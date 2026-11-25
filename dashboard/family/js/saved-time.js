// Shared wording and arithmetic for a child's earned Internet time.
export function durationLabel(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0)), hours = Math.floor(total / 60), rest = total % 60;
  return [hours && `${hours} h`, (rest || !hours) && `${rest} min`].filter(Boolean).join(' ');
}

// What a child has to spend. "Saved" time is banked up to the household cap; a
// reward earned at the cap is use-it-or-lose-it and is counted separately.
// Credits are ordered soonest-to-expire, so spending never lets an older one lapse.
export function savedTime(data, personId) {
  const now = Date.parse(data?.serverTime) || Date.now();
  const credits = (data?.credits || []).filter(credit => credit.personId === personId && credit.status === 'available' && !(Date.parse(credit.expiresAt) <= now))
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  const sum = list => list.reduce((total, credit) => total + credit.minutes, 0);
  const today = credits.filter(credit => credit.useOrLose), saved = sum(credits.filter(credit => !credit.useOrLose));
  const cap = Number.isFinite(data?.savedCapMinutes) ? data.savedCapMinutes : null;
  return { credits, next: credits[0] || null, savedMinutes: saved, todayOnlyMinutes: sum(today), totalMinutes: sum(credits),
    capMinutes: cap, atCap: cap !== null && saved >= cap, fraction: cap ? Math.min(1, saved / cap) : 0 };
}

// The sentence a child reads right after earning a reward.
export function earnedMessage(credit, time) {
  if (credit.useOrLose) return `You’ve maxed out how much time you can save${time.capMinutes ? ` (${durationLabel(time.capMinutes)})` : ''}. The ${durationLabel(credit.minutes)} you just earned is use it or lose it: use it today, or it is gone at midnight.`;
  return `Use it now, or save it. You have ${durationLabel(time.savedMinutes)} saved${time.capMinutes ? ` of ${durationLabel(time.capMinutes)}` : ''}.`;
}
