/* === Assistant natural-language parser (pure, shared module) ===
   Extracted from renderer.js so the date/time parsing can be unit-tested in
   isolation (no DOM, no localStorage). Loaded as a classic <script> (sets
   window.AssistantParser) AND require-able from Node for `node --test`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AssistantParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

  function assistantCleanName(s) {
    return String(s)
      .trim()
      .replace(/\s+(?:by|at|before|due|on)\s*$/i, '')   // trailing connectors ("… by")
      .replace(/^(?:to|about|the|a|an)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Pull a "when" phrase out of the text → { due: 'YYYY-MM-DD', time: 'HH:MM', rest }.
  // `now` is injectable for deterministic tests (defaults to the real clock).
  function assistantExtractWhen(text, now) {
    now = now || new Date();
    const s = String(text);
    let rest = s;

    // "in 30 minutes" / "in 2 hours" / "in 3 days"
    const rel = rest.match(/\bin\s+(\d+)\s*(min|mins|minutes?|h|hr|hrs|hours?|day|days?|week|weeks?)\b/i);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const u = rel[2].toLowerCase();
      const ms = u[0] === 'h' ? n * 3600000
        : u[0] === 'd' ? n * 86400000
        : u[0] === 'w' ? n * 7 * 86400000
        : n * 60000;
      const d = new Date(now.getTime() + ms);
      return { due: dayKey(d), time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()), rest: rest.replace(rel[0], ' ') };
    }

    // Day words: today / tomorrow / tonight / (next) weekday
    let dayShift = 0;
    const dayMatch = rest.match(/\b(today|tomorrow|tonight|(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i);
    if (dayMatch) {
      const dw = dayMatch[1].toLowerCase();
      if (dw === 'tomorrow') dayShift = 1;
      else if (dw !== 'today' && dw !== 'tonight') {
        const dowMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const dow = dowMap[dw.replace(/^next\s+/, '').slice(0, 3)];
        let diff = (dow - now.getDay() + 7) % 7;
        if (/^next\s+/.test(dw) && diff === 0) diff = 7;
        dayShift = diff;
      }
      rest = rest.replace(dayMatch[0], ' ');
    }

    // Clock times: "3:30pm", "15:30", "3 pm", "at 5" — or a bare hour right
    // after a day word ("friday 3"). Bare digits elsewhere are left alone so
    // names like "review chapter 5" stay intact.
    let timeMatch = rest.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/i)
      || rest.match(/\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/i)
      || rest.match(/\bat\s+(\d{1,2})\b/i)
      || (dayMatch ? rest.match(/\b(\d{1,2})\b/) : null);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      // Group layout differs per alternative: "3:30pm" puts minutes in [2] and
      // am/pm in [3]; "3 pm" / "at 3" put am/pm (or nothing) in [2].
      const min = /^\d+$/.test(timeMatch[2] || '') ? parseInt(timeMatch[2], 10) : 0;
      const ap = /^(am|pm)$/i.test(timeMatch[2] || '') ? timeMatch[2].toLowerCase() : (timeMatch[3] || null);
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      // Bare hours with no AM/PM ("at 3", "3:30", "friday 3"): 1–7 read as
      // afternoon/evening ("meeting at 3" is 3 PM, not 3 AM).
      if (!ap && h >= 1 && h <= 7) h += 12;
      if (h > 23) h %= 24;
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + dayShift);
      d.setHours(h, min, 0, 0);
      rest = rest.replace(timeMatch[0], ' ');
      return { due: dayKey(d), time: pad2(h) + ':' + pad2(min), rest };
    }
    if (dayShift > 0) { // day word, no clock — default 9am
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + dayShift);
      d.setHours(9, 0, 0, 0);
      return { due: dayKey(d), time: '09:00', rest };
    }
    // "12/25" style dates
    const dm = rest.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (dm) {
      const d = new Date(now.getFullYear(), parseInt(dm[1], 10) - 1, parseInt(dm[2], 10));
      d.setHours(9, 0, 0, 0);
      return { due: dayKey(d), time: '09:00', rest: rest.replace(dm[0], ' ') };
    }
    return null;
  }

  return { pad2, dayKey, assistantCleanName, assistantExtractWhen };
});
