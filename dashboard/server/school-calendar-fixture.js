// Public district dates used to check the imported calendar's 174 student days.
// Family members, chores, accounts and production configuration are synthetic.
export const schoolCalendarFixture = () => ({
  title: 'Fixture district 2026–27', sourceName: 'Approved district calendar', sourceUrl: 'https://example.com/school-calendar', sourceSha256: 'a'.repeat(64),
  coverageStart: '2026-07-01', coverageEndExclusive: '2027-07-01', termStart: '2026-08-20', termEndExclusive: '2027-05-29', weekdays: [1, 2, 3, 4, 5], overrides: [],
  closures: [
    ['2026-08-13', '2026-08-15', 'Professional days'], ['2026-08-17', '2026-08-19', 'Professional days'], ['2026-08-19', '2026-08-20', 'Contract day'],
    ['2026-09-07', '2026-09-08', 'Labor Day'], ['2026-10-14', '2026-10-15', 'Professional day'], ['2026-10-15', '2026-10-17', 'Fall break'],
    ['2026-11-25', '2026-11-26', 'Compensation day'], ['2026-11-26', '2026-11-28', 'Thanksgiving break'], ['2026-12-21', '2027-01-02', 'Winter break'],
    ['2027-01-04', '2027-01-06', 'Professional days'], ['2027-01-18', '2027-01-19', 'Martin Luther King Day'], ['2027-02-12', '2027-02-13', 'Compensation day / possible makeup day'],
    ['2027-02-15', '2027-02-16', 'Presidents Day'], ['2027-03-12', '2027-03-13', 'Professional day'], ['2027-04-05', '2027-04-10', 'Spring break'], ['2027-05-31', '2027-06-01', 'Memorial Day'],
  ].map(([fromDate, toDateExclusive, label]) => ({ fromDate, toDateExclusive, label })),
});
