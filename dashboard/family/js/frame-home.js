import { taskGroups, taskOverview } from './presentation.js';
import { taskSections } from './occurrences.js';

// Use only the current authorized snapshot. A child-scoped frame unlock must
// never retain another child's previous lane or borrow the Tasks-page filter.
export function frameTaskLanes(profiles, items, schoolDay, recent = new Set()) {
  return profiles.map(profile => {
    const tasks = items.filter(item => item.personId === profile.id);
    const groups = taskGroups(tasks, schoolDay), overview = taskOverview(tasks, schoolDay);
    const current = [...groups.todo, ...groups.submitted, ...groups.completed];
    const visible = [...groups.todo, ...groups.submitted, ...groups.completed.filter(item => recent.has(item.id))];
    return { profile, groups, overview, currentCount: current.length,
      sections: taskSections(visible, schoolDay), visible };
  });
}
