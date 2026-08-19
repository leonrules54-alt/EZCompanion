const test = require('node:test');
const assert = require('node:assert/strict');
const { pad2, dayKey, assistantCleanName, assistantExtractWhen, assistantExtractClassDef, assistantExtractClassDefs, assistantMatchClass, nextClassDate, nextClassDateTime } = require('../assistant-parser.js');

// Wed Jan 7 2026, noon local time — a fixed clock so every assertion is deterministic.
const NOW = new Date(2026, 0, 7, 12, 0, 0);

test('pad2 / dayKey format keys', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(11), '11');
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dayKey(new Date(2026, 11, 31)), '2026-12-31');
});

test('class defs: multi-class schedule in one message', () => {
  const defs = assistantExtractClassDefs('remember my schedule: history mon wed 9am, math tue thu 10am, bio fri 11am');
  assert.equal(defs.length, 3);
  assert.deepEqual(defs[0], { name: 'history', days: ['mon', 'wed'], time: '09:00' });
  assert.deepEqual(defs[1], { name: 'math', days: ['tue', 'thu'], time: '10:00' });
  assert.deepEqual(defs[2], { name: 'bio', days: ['fri'], time: '11:00' });
});

test('class defs: comma-split day list stays one class', () => {
  const defs = assistantExtractClassDefs('remember my history class is monday, wednesday and friday at 9am');
  assert.equal(defs.length, 1);
  assert.deepEqual(defs[0], { name: 'history', days: ['mon', 'wed', 'fri'], time: '09:00' });
});

test('class defs: bare schedule form with multi-word name', () => {
  const defs = assistantExtractClassDefs('my schedule: AP us history on tue and thu at 2pm, intro to engineering fri 1pm');
  assert.equal(defs.length, 2);
  assert.deepEqual(defs[0], { name: 'AP us history', days: ['tue', 'thu'], time: '14:00' });
  assert.deepEqual(defs[1], { name: 'intro to engineering', days: ['fri'], time: '13:00' });
});

test('class defs: bare name list (no schedule yet)', () => {
  const defs = assistantExtractClassDefs('my classes are history, math, bio');
  assert.deepEqual(defs.map((d) => d.name), ['history', 'math', 'bio']);
  assert.ok(defs.every((d) => !d.days.length && !d.time));
});

test('class defs: single "name class" still parses', () => {
  const defs = assistantExtractClassDefs('remember my history class is Monday Wednesday at 9am');
  assert.equal(defs.length, 1);
  assert.deepEqual(defs[0], { name: 'history', days: ['mon', 'wed'], time: '09:00' });
});

test('class defs: "add history class homework" is NOT a class def', () => {
  assert.deepEqual(assistantExtractClassDefs('add history class homework due tomorrow'), []);
});

test('nextClassDateTime: next meeting from a Wednesday noon', () => {
  // Mon/Wed 09:00, now = Wed Jan 7 2026 12:00 → today's 9am passed → next Monday.
  const dt = nextClassDateTime({ name: 'history', days: ['mon', 'wed'], time: '09:00' }, NOW);
  assert.equal(dayKey(dt), '2026-01-12');
  assert.equal(dt.getHours(), 9);
  assert.equal(dt.getMinutes(), 0);
});

test('nextClassDateTime: later today counts as the next meeting', () => {
  // Wed 14:00, now = Wed noon → today at 2pm.
  const dt = nextClassDateTime({ name: 'math', days: ['wed'], time: '14:00' }, NOW);
  assert.equal(dayKey(dt), '2026-01-07');
  assert.equal(dt.getHours(), 14);
});

test('nextClassDateTime: no time → next day, never today', () => {
  const dt = nextClassDateTime({ name: 'bio', days: ['wed'], time: '' }, NOW);
  assert.equal(dayKey(dt), '2026-01-14');
});

test('nextClassDateTime: no days → null', () => {
  assert.equal(nextClassDateTime({ name: 'chem', days: [], time: '09:00' }, NOW), null);
});

test('relative: "in 30 minutes"', () => {
  const r = assistantExtractWhen('in 30 minutes', NOW);
  assert.equal(r.due, '2026-01-07');
  assert.equal(r.time, '12:30');
});

test('relative: "in 2 hours"', () => {
  assert.equal(assistantExtractWhen('in 2 hours', NOW).time, '14:00');
});

test('relative: "in 1 day" keeps the clock time', () => {
  const r = assistantExtractWhen('in 1 day', NOW);
  assert.equal(r.due, '2026-01-08');
  assert.equal(r.time, '12:00');
});

test('"tomorrow" with no clock defaults to 9am', () => {
  const r = assistantExtractWhen('tomorrow', NOW);
  assert.equal(r.due, '2026-01-08');
  assert.equal(r.time, '09:00');
});

test('weekday: "next Thursday" (from a Wednesday)', () => {
  assert.equal(assistantExtractWhen('next Thursday', NOW).due, '2026-01-08');
});

test('weekday: "next Wednesday" on the same weekday rolls a full week', () => {
  assert.equal(assistantExtractWhen('next Wednesday', NOW).due, '2026-01-14');
});

test('bare "at 3" reads as 3pm', () => {
  const r = assistantExtractWhen('meeting at 3', NOW);
  assert.equal(r.due, '2026-01-07');
  assert.equal(r.time, '15:00');
});

test('am/pm parsing: "3:30pm", "9am", "9pm"', () => {
  assert.equal(assistantExtractWhen('call at 3:30pm', NOW).time, '15:30');
  assert.equal(assistantExtractWhen('call tomorrow at 9am', NOW).time, '09:00');
  assert.equal(assistantExtractWhen('call tomorrow at 9pm', NOW).time, '21:00');
});

test('24-hour clock is left alone', () => {
  assert.equal(assistantExtractWhen('call at 15:30', NOW).time, '15:30');
});

test('bare digits without a day word are not treated as a time', () => {
  assert.equal(assistantExtractWhen('review chapter 5', NOW), null);
});

test('full phrase: name preserved, date/time stripped', () => {
  const r = assistantExtractWhen('I have a test next Thursday at 2pm', NOW);
  assert.equal(r.due, '2026-01-08');
  assert.equal(r.time, '14:00');
  assert.equal(r.rest.trim(), 'I have a test');
});

test('slash date: "12/25"', () => {
  const r = assistantExtractWhen('party on 12/25', NOW);
  assert.equal(r.due, '2026-12-25');
  assert.equal(r.time, '09:00');
});

test('named clocks: noon, midday, midnight', () => {
  assert.equal(assistantExtractWhen('lunch at noon', NOW).time, '12:00');
  assert.equal(assistantExtractWhen('standup at midday', NOW).time, '12:00');
  assert.equal(assistantExtractWhen('call at midnight', NOW).time, '00:00');
});

test('"tonight" defaults to 8pm', () => {
  const r = assistantExtractWhen('party tonight', NOW);
  assert.equal(r.due, '2026-01-07');
  assert.equal(r.time, '20:00');
  assert.equal(r.rest.trim(), 'party');
});

test('"next week" → the upcoming Monday', () => {
  const r = assistantExtractWhen('next week', NOW);
  assert.equal(r.due, '2026-01-12');
  assert.equal(r.time, '09:00');
});

test('"next month" → the 1st of next month', () => {
  const r = assistantExtractWhen('pay rent next month', NOW);
  assert.equal(r.due, '2026-02-01');
  assert.equal(r.time, '09:00');
  assert.equal(r.rest.trim(), 'pay rent');
});

test('"this weekend" → Saturday', () => {
  assert.equal(assistantExtractWhen('hike this weekend', NOW).due, '2026-01-10');
});

test('no date/time present → null', () => {
  assert.equal(assistantExtractWhen('write the report', NOW), null);
});

test('assistantCleanName strips trailing connectors + leading articles', () => {
  assert.equal(assistantCleanName('write report by '), 'write report');
  assert.equal(assistantCleanName('to buy milk'), 'buy milk');
  assert.equal(assistantCleanName('the meeting at'), 'meeting');
  assert.equal(assistantCleanName('  a  thing  '), 'thing');
});

test('assistantCleanName strips "task called" filler', () => {
  assert.equal(assistantCleanName('daily task called Pickleball'), 'Pickleball');
  assert.equal(assistantCleanName('a task called report'), 'report');
  assert.equal(assistantCleanName('task named taxes'), 'taxes');
  assert.equal(assistantCleanName('called Pickleball'), 'Pickleball');
  assert.equal(assistantCleanName('daily standup'), 'daily standup');
});

test('"today" sets the due date and stays out of the name', () => {
  const r = assistantExtractWhen('pickleball today', NOW);
  assert.equal(r.due, '2026-01-07');
  assert.equal(r.time, '');
  assert.equal(r.rest.trim(), 'pickleball');
});

// === Class memory (assistant knowledge base) ===

test('assistantExtractClassDef: full sentence', () => {
  const r = assistantExtractClassDef('remember my history class is Monday Wednesday at 9am');
  assert.equal(r.name, 'history');
  assert.deepEqual(r.days, ['mon', 'wed']);
  assert.equal(r.time, '09:00');
});

test('assistantExtractClassDef: abbreviated days + 24h time', () => {
  const r = assistantExtractClassDef('save math class Mon Wed Fri 9:00');
  assert.equal(r.name, 'math');
  assert.deepEqual(r.days, ['mon', 'wed', 'fri']);
  assert.equal(r.time, '09:00');
});

test('assistantExtractClassDef: multi-word name without a verb', () => {
  const r = assistantExtractClassDef('my AP us history class meets on tue and thu');
  assert.equal(r.name, 'AP us history');
  assert.deepEqual(r.days, ['tue', 'thu']);
  assert.equal(r.time, '');
});

test('assistantExtractClassDef: "monday to friday" expands the week', () => {
  const r = assistantExtractClassDef('remember science class monday to friday 8:30');
  assert.equal(r.name, 'science');
  assert.deepEqual(r.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(r.time, '08:30');
});

test('assistantExtractClassDef: "every weekday"', () => {
  const r = assistantExtractClassDef('remember biology class every weekday at 10am');
  assert.deepEqual(r.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(r.time, '10:00');
});

test('assistantExtractClassDef: time only (no days) is still remembered', () => {
  const r = assistantExtractClassDef('my math class is at 9am');
  assert.equal(r.name, 'math');
  assert.deepEqual(r.days, []);
  assert.equal(r.time, '09:00');
});

test('assistantExtractClassDef: a task mentioning a class is NOT a class def', () => {
  assert.equal(assistantExtractClassDef('add history class homework'), null);
  assert.equal(assistantExtractClassDef('remember to study for the test'), null);
});

test('assistantMatchClass matches a class inside a task name', () => {
  const mem = { classes: [{ name: 'History', days: ['mon', 'wed', 'fri'], time: '09:00' }] };
  assert.equal(assistantMatchClass(mem, 'history homework essay').name, 'History');
  assert.equal(assistantMatchClass(mem, 'History homework').name, 'History');
  assert.equal(assistantMatchClass(mem, 'add math homework'), null);
  assert.equal(assistantMatchClass(mem, 'finish the report'), null);
});

test('assistantMatchClass matches multi-word class names as phrases', () => {
  const mem = { classes: [{ name: 'AP us history', days: ['tue', 'thu'] }] };
  assert.equal(assistantMatchClass(mem, 'ap us history essay').name, 'AP us history');
  assert.equal(assistantMatchClass(mem, 'history essay'), null);
});

test('nextClassDate picks the earliest next meeting', () => {
  const cls = { name: 'History', days: ['mon', 'wed', 'fri'], time: '09:00' };
  // Wed Jan 7 2026 → next meeting is Friday Jan 9
  assert.equal(nextClassDate(cls, NOW), '2026-01-09');
  // Thu Jan 8 → Monday Jan 12 (same-week Fri is Jan 9)
  assert.equal(nextClassDate(cls, new Date(2026, 0, 8, 9, 0, 0)), '2026-01-09');
  // Friday Jan 9 → Monday Jan 12 (never "today")
  assert.equal(nextClassDate(cls, new Date(2026, 0, 9, 9, 0, 0)), '2026-01-12');
});

test('nextClassDate returns empty for a class with no days', () => {
  assert.equal(nextClassDate({ name: 'Math', days: [] }, NOW), '');
  assert.equal(nextClassDate({ name: 'Math' }, NOW), '');
});
