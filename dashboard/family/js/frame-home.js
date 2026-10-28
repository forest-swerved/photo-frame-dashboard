import { taskGroups, taskOverview } from './presentation.js';
import { taskSections } from './occurrences.js';

// Use only the current authorized snapshot. A child-scoped frame unlock must
// never retain another child's previous lane or borrow the Tasks-page filter.
export function frameTaskLanes(profiles, items, schoolDay) {
  return profiles.map(profile => {
    const tasks = items.filter(item => item.personId === profile.id);
    const groups = taskGroups(tasks, schoolDay), overview = taskOverview(tasks, schoolDay);
    const current = [...groups.todo, ...groups.submitted, ...groups.completed];
    const sections = taskSections([...groups.todo, ...groups.submitted], schoolDay);
    if (groups.completed.length) sections.push({ id: 'completed', label: 'Completed today', items: groups.completed });
    const visible = sections.flatMap(section => section.items);
    return { profile, groups, overview, currentCount: current.length,
      sections, visible };
  });
}
