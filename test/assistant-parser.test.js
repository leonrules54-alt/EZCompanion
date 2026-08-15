const test = require('node:test');
const assert = require('node:assert/strict');
const { pad2, dayKey, assistantCleanName, assistantExtractWhen } = require('../assistant-parser.js');

// Wed Jan 7 2026, noon local time — a fixed clock so every assertion is deterministic.
const NOW = new Date(2026, 0, 7, 12, 0, 0);

test('pad2 / dayKey format keys', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(11), '11');
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dayKey(new Date(2026, 11, 31)), '2026-12-31');
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

test('no date/time present → null', () => {
  assert.equal(assistantExtractWhen('write the report', NOW), null);
});

test('assistantCleanName strips trailing connectors + leading articles', () => {
  assert.equal(assistantCleanName('write report by '), 'write report');
  assert.equal(assistantCleanName('to buy milk'), 'buy milk');
  assert.equal(assistantCleanName('the meeting at'), 'meeting');
  assert.equal(assistantCleanName('  a  thing  '), 'thing');
});
