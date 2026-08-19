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
      .replace(/^(?:(?:the|a|an|my)\s+)?(?:(?:daily|recurring|quick|new|another)\s+)?task\s+/i, '')   // "a daily task X" → "X"
      .replace(/^(?:called|named|titled)\s+/i, '')       // "called X" → "X"
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
    let sameDayAnchor = false; // today / tonight / "wednesday" on a Wednesday
    let isTonight = false;
    const dayMatch = rest.match(/\b(today|tomorrow|tonight|(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i);
    if (dayMatch) {
      const dw = dayMatch[1].toLowerCase();
      if (dw === 'tomorrow') dayShift = 1;
      else if (dw === 'tonight') { dayShift = 0; isTonight = true; }
      else if (dw !== 'today') {
        const dowMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const dow = dowMap[dw.replace(/^next\s+/, '').slice(0, 3)];
        let diff = (dow - now.getDay() + 7) % 7;
        if (/^next\s+/.test(dw) && diff === 0) diff = 7;
        dayShift = diff;
      }
      if (dayShift === 0) sameDayAnchor = true;
      rest = rest.replace(dayMatch[0], ' ');
    }

    // Broader anchors with no day word: "next week" → the upcoming Monday,
    // "next month" → the 1st of next month, "this/next weekend" → Saturday.
    // These all land at 9am unless a clock is also given.
    let target = null;
    if (!dayMatch) {
      const nextWeekMonth = rest.match(/\bnext\s+(week|month)\b/i);
      const weekend = rest.match(/\b(this|next)\s+weekend\b/i);
      if (nextWeekMonth) {
        const kind = nextWeekMonth[1].toLowerCase();
        const d = new Date(now.getTime());
        if (kind === 'month') {
          d.setDate(1);
          d.setMonth(d.getMonth() + 1);
        } else { // week → the upcoming Monday
          let diff = (1 - d.getDay() + 7) % 7;
          if (diff === 0) diff = 7;
          d.setDate(d.getDate() + diff);
        }
        target = d;
        rest = rest.replace(nextWeekMonth[0], ' ');
      } else if (weekend) {
        const qual = weekend[1].toLowerCase();
        const d = new Date(now.getTime());
        let diff = (6 - d.getDay() + 7) % 7; // this Saturday
        if (qual === 'next') diff += 7;
        d.setDate(d.getDate() + diff);
        target = d;
        rest = rest.replace(weekend[0], ' ');
      }
    }

    // Named clock words: noon / midday / midnight.
    const clockWord = rest.match(/\b(noon|midday|midnight)\b/i);

    // Clock times: "3:30pm", "15:30", "3 pm", "at 5" — or a bare hour right
    // after a day word ("friday 3"). Bare digits elsewhere are left alone so
    // names like "review chapter 5" stay intact.
    let timeMatch = rest.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b/i)
      || rest.match(/\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/i)
      || rest.match(/\bat\s+(\d{1,2})\b/i)
      || (dayMatch ? rest.match(/\b(\d{1,2})\b/) : null);

    let hour = null;
    let minute = 0;
    if (clockWord) {
      hour = clockWord[1].toLowerCase() === 'midnight' ? 0 : 12;
      rest = rest.replace(clockWord[0], ' ');
    } else if (timeMatch) {
      hour = parseInt(timeMatch[1], 10);
      // Group layout differs per alternative: "3:30pm" puts minutes in [2] and
      // am/pm in [3]; "3 pm" / "at 3" put am/pm (or nothing) in [2].
      minute = /^\d+$/.test(timeMatch[2] || '') ? parseInt(timeMatch[2], 10) : 0;
      const ap = /^(am|pm)$/i.test(timeMatch[2] || '') ? timeMatch[2].toLowerCase() : (timeMatch[3] || null);
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
      // Bare hours with no AM/PM ("at 3", "3:30", "friday 3"): 1–7 read as
      // afternoon/evening ("meeting at 3" is 3 PM, not 3 AM).
      if (!ap && hour >= 1 && hour <= 7) hour += 12;
      if (hour > 23) hour %= 24;
      rest = rest.replace(timeMatch[0], ' ');
    }

    if (hour !== null) {
      const d = target || new Date(now.getTime());
      if (!target) d.setDate(d.getDate() + dayShift);
      d.setHours(hour, minute, 0, 0);
      return { due: dayKey(d), time: pad2(hour) + ':' + pad2(minute), rest };
    }

    if (dayMatch || target) { // an anchor, no clock — keep the cleaned name
      const d = target || new Date(now.getTime());
      if (!target) d.setDate(d.getDate() + dayShift);
      d.setHours(9, 0, 0, 0);
      if (isTonight) { // "tonight" reads as 8pm, not "no time"
        d.setHours(20, 0, 0, 0);
        return { due: dayKey(d), time: '20:00', rest };
      }
      if (sameDayAnchor) return { due: dayKey(d), time: '', rest }; // today: no specific clock
      return { due: dayKey(d), time: '09:00', rest }; // tomorrow / weekday / week / month
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

  // "every monday" / "every day" / "weekly" → { recur, rest } or null.
  function assistantExtractRecur(s) {
    const m = String(s).match(/\bevery\s+(day|daily|week|weekly|weekday|weekdays|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (!m) return null;
    const w = m[1].toLowerCase();
    let recur;
    if (w === 'day' || w === 'daily') recur = 'daily';
    else if (w === 'week' || w === 'weekly') recur = 'weekly';
    else if (w === 'weekday' || w === 'weekdays') recur = 'weekday';
    else recur = w.slice(0, 3); // mon, tue, wed…
    return { recur, rest: String(s).replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  }

  // Next occurrence date for a recur tag ("daily", "weekly", "weekday", "mon").
  function nextRecurDate(recur, now) {
    now = now || new Date();
    if (recur === 'daily') { const d = new Date(now); d.setDate(d.getDate() + 1); return dayKey(d); }
    if (recur === 'weekly') { const d = new Date(now); d.setDate(d.getDate() + 7); return dayKey(d); }
    if (recur === 'weekday') { const d = new Date(now); do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); return dayKey(d); }
    const dowMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const dow = dowMap[recur];
    if (dow === undefined) return '';
    const d = new Date(now);
    let diff = (dow - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return dayKey(d);
  }

  // === Assistant memory (classes / schedule) ===
  // The assistant keeps a small knowledge base of the user's world — their
  // classes (name + which days + start time) — so a message like "history
  // homework due tomorrow" can resolve against a remembered History class,
  // and "add math homework" (no date) lands on the next Math class. Pure
  // helpers here; renderer.js owns the persisted store.

  const CLASS_DAY_ALIASES = {
    sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu',
    friday: 'fri', saturday: 'sat', sun: 'sun', mon: 'mon', tue: 'tue', wed: 'wed',
    thu: 'thu', fri: 'fri', sat: 'sat',
  };
  const CLASS_DOW_NUM = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // "remember my history class is Monday Wednesday at 9am" / "save math class
  // Mon Wed Fri 9:00" / "my AP us history class meets on tue and thu".
  // Returns { name, days: ['mon','wed','fri'], time: 'HH:MM' } or null (when
  // no schedule info — days or a time — is found, so "add history class
  // homework" is NOT treated as a class definition).
  function assistantExtractClassDef(s) {
    const text = String(s).replace(/\s+/g, ' ').trim();
    const m = text.match(
      /(?:\b(?:remember|save|note|set|add|log|store)\b\s+)?(?:my|the|a|an|our)?\s*([A-Za-z][A-Za-z0-9 &'+#.-]{1,40}?)\s+(?:class|course|subject)\b(?:\s+(?:is|meets|happens|runs|starts|on|at|from|in)\b)?\s*([^.,;!?]*)$/i
    );
    if (!m) return null;
    let name = m[1].replace(/^(?:my|the|a|an|our)\s+/i, '').trim();
    if (name.length < 2) return null;
    const tail = m[2].trim();

    const days = extractClassDays(tail);
    const time = extractClassTime(tail);
    if (!days.length && !time) return null;
    return { name, days, time };
  }

  // Day-of-week words → 3-letter keys, in week order ("mon tue … sun").
  // Handles "monday and wednesday", "mon-thu" / "monday to friday" ranges,
  // and "every day" / "every weekday" shorthand.
  function extractClassDays(text) {
    const days = [];
    const dayRe = /\b(?:every\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi;
    let dm;
    while ((dm = dayRe.exec(String(text))) !== null) {
      const d = CLASS_DAY_ALIASES[dm[1].toLowerCase()];
      if (d && !days.includes(d)) days.push(d);
    }
    const range = String(text).match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b\s*(?:-|to)\s*\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i);
    if (range) {
      const a = CLASS_DOW_NUM[CLASS_DAY_ALIASES[range[1].toLowerCase()]];
      const b = CLASS_DOW_NUM[CLASS_DAY_ALIASES[range[2].toLowerCase()]];
      if (a !== undefined && b !== undefined) {
        let i = a;
        while (true) {
          const d = Object.keys(CLASS_DOW_NUM)[i];
          if (!days.includes(d)) days.push(d);
          if (i === b) break;
          i = (i + 1) % 7;
        }
      }
    }
    if (/\bevery\s+day\b/i.test(text)) { ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach((d) => { if (!days.includes(d)) days.push(d); }); }
    if (/\bevery\s+weekday\b/i.test(text)) { ['mon', 'tue', 'wed', 'thu', 'fri'].forEach((d) => { if (!days.includes(d)) days.push(d); }); }
    days.sort((a, b) => (CLASS_DOW_NUM[a] || 9) - (CLASS_DOW_NUM[b] || 9));
    return days;
  }

  // Clock time → 'HH:MM' ("9am", "9:30 am", "14:00", bare "9" with no am/pm
  // reads as PM only in the 1..7 range, matching how people say class times).
  function extractClassTime(text) {
    const tm = String(text).match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
      || String(text).match(/\b(?:at\s+)(\d{1,2})(?::(\d{2}))?\b/i)
      || String(text).match(/\b(\d{1,2}):(\d{2})\b/i);
    if (!tm) return '';
    let h = parseInt(tm[1], 10);
    const min = /^\d+$/.test(tm[2] || '') ? parseInt(tm[2], 10) : 0;
    const ap = /^(am|pm)$/i.test(tm[3] || '') ? tm[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 7) h += 12;
    if (h > 23) h %= 24;
    return pad2(h) + ':' + pad2(min);
  }

  // Words that end a class name in the bare "name <days/time>" form.
  const CLASS_NAME_STOP = /^(?:at|on|from|is|meets|happens|runs|starts|in|between|every|class|course|subject)$/i;

  // Schedule-context form with no "class" word: "history mon wed at 9am" /
  // "AP us history on tue thu". Returns { name, days, time } — days/time may
  // be empty (a bare name, e.g. from "my classes are history, math, bio" —
  // the caller decides what that means).
  function extractBareDef(seg) {
    const toks = String(seg).trim().split(/\s+/);
    const nameToks = [];
    let i = 0;
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (CLASS_DAY_ALIASES[t.toLowerCase()] || CLASS_NAME_STOP.test(t) || /^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(t)) break;
      nameToks.push(t);
    }
    const name = nameToks.join(' ').replace(/^(?:my|the|a|an|our)\s+/i, '').trim();
    if (name.length < 2) return null;
    const tail = toks.slice(i).join(' ');
    return { name, days: extractClassDays(tail), time: extractClassTime(tail) };
  }

  const CLASS_INTRO_RE = /^(?:(?:please\s+)?(?:remember|save|note|set|add|log|store|tell\s+me)\s+)?(?:my|the|our|your)?\s*(?:class(?:es)?|course(?:es)?|subject(?:es)?|schedule|timetable)\s*(?:are|is|:|of|=)?\s*/i;

  // One message can describe several classes ("remember my schedule: history
  // mon wed 9am, math tue thu 10am"). Splits on commas/semicolons, keeps
  // single-class day lists intact ("history class is monday, wednesday at
  // 9am" — the bare day/time fragments merge into the previous class), and
  // handles both "X class …" and bare "X <days/time>" forms.
  function assistantExtractClassDefs(s) {
    const text = String(s).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const scheduleCtx = /\b(?:schedule|timetable)\b/i.test(text)
      || /\b(?:classes?|courses?|subjects?)\s*(?:are|is|:|=)\b/i.test(text);
    const body = text.replace(CLASS_INTRO_RE, ' ').trim() || text;
    const segments = body.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    if (!segments.length) return [];

    const defs = [];
    for (const seg of segments) {
      let def = assistantExtractClassDef(seg);
      if (!def && scheduleCtx) def = extractBareDef(seg);
      if (def) {
        defs.push(def);
        continue;
      }
      // A fragment like "wed" or "and fri at 9am" — merge into the previous
      // class's schedule so day lists survive the comma split.
      const prev = defs[defs.length - 1];
      const d2 = extractClassDays(seg);
      const t2 = extractClassTime(seg);
      if (prev && (d2.length || t2)) {
        d2.forEach((d) => { if (!prev.days.includes(d)) prev.days.push(d); });
        prev.days.sort((a, b) => (CLASS_DOW_NUM[a] || 9) - (CLASS_DOW_NUM[b] || 9));
        if (t2) prev.time = t2;
      }
    }
    return defs;
  }

  // Date+time of the class's next meeting (today counts when its time hasn't
  // passed yet; classes without a time start on their next day, never today).
  // Returns a Date, or null when the class has no days.
  function nextClassDateTime(cls, now) {
    now = now || new Date();
    const days = cls && Array.isArray(cls.days) ? cls.days : [];
    if (!days.length) return null;
    const tm = /^(\d{2}):(\d{2})$/.exec(cls.time || '');
    let best = null;
    for (const d of days) {
      const dow = CLASS_DOW_NUM[String(d).toLowerCase().slice(0, 3)];
      if (dow === undefined) continue;
      const dt = new Date(now);
      let diff = (dow - now.getDay() + 7) % 7;
      if (!tm && diff === 0) diff = 7; // no clock: next day, never today
      dt.setDate(dt.getDate() + diff);
      if (tm) {
        dt.setHours(parseInt(tm[1], 10), parseInt(tm[2], 10), 0, 0);
        if (diff === 0 && dt.getTime() <= now.getTime()) dt.setDate(dt.getDate() + 7);
      }
      if (!best || dt.getTime() < best.getTime()) best = dt;
    }
    return best;
  }

  // Does the text mention a remembered class? Returns the class object or
  // null. Single-word classes match as a whole word ("history" in "history
  // homework") and, for longer names, as a word prefix ("historyhw").
  function assistantMatchClass(memory, text) {
    const classes = memory && Array.isArray(memory.classes) ? memory.classes : [];
    const tl = String(text || '').toLowerCase();
    for (const c of classes) {
      const name = String(c && c.name || '').toLowerCase().trim();
      if (!name) continue;
      const words = name.split(/\s+/);
      if (words.length === 1) {
        const rx = new RegExp('\\b' + escapeRegExp(name) + '\\b');
        if (rx.test(tl)) return c;
        if (name.length >= 4 && new RegExp('\\b' + escapeRegExp(name)).test(tl)) return c;
      } else if (tl.includes(name)) {
        return c;
      }
    }
    return null;
  }

  // Next meeting date for a class (earliest of its days after `now`). Empty
  // string when the class has no days.
  function nextClassDate(cls, now) {
    now = now || new Date();
    const days = cls && Array.isArray(cls.days) ? cls.days : [];
    if (!days.length) return '';
    let best = '';
    for (const d of days) {
      const dow = CLASS_DOW_NUM[String(d).toLowerCase().slice(0, 3)];
      if (dow === undefined) continue;
      const dt = new Date(now);
      let diff = (dow - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // next occurrence, never today
      dt.setDate(dt.getDate() + diff);
      const key = dayKey(dt);
      if (!best || key < best) best = key;
    }
    return best;
  }

  return { pad2, dayKey, assistantCleanName, assistantExtractWhen, assistantExtractRecur, nextRecurDate, assistantExtractClassDef, assistantExtractClassDefs, assistantMatchClass, nextClassDate, nextClassDateTime };
});
