#!/usr/bin/env node
/* Test the OpenRouter assistant integration directly — no Electron needed.
   Mirrors the app's system prompt + JSON schema, sends a battery of prompts,
   and prints the model's raw JSON so you can judge how well it plans.

   Usage:
     OPENROUTER_API_KEY=sk-or-... node scripts/test-assistant-ai.js
   or:
     node scripts/test-assistant-ai.js sk-or-...
*/

const key = process.env.OPENROUTER_API_KEY || process.argv[2] || '';
if (!key) {
  console.error('Pass your key: OPENROUTER_API_KEY=sk-or-... node scripts/test-assistant-ai.js');
  process.exit(1);
}

// Same fallback chain the app uses (free models, per-provider rate limits).
const MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3.5-lightning:free',
  'openai/gpt-oss-20b:free',
];

const SYSTEM = [
  'You are the assistant inside a desktop productivity app (tasks + deadlines).',
  'Control the app by replying with a SINGLE JSON object and nothing else.',
  'Schema: {reply: short answer, action: {type, ...}}.',
  'Action types: add_task, add_deadline, complete_task, delete_task, none.',
  'add_task fields: name, due (YYYY-MM-DD or null), durationMin (number or null), category (name or null).',
  'add_deadline fields: name, due (YYYY-MM-DD or null), time (HH:MM 24h or null).',
  'complete_task and delete_task fields: taskQuery (name or unique fragment).',
  'none means no app change; answer the question in reply.',
  'Rules: output valid JSON only; convert relative dates and times (tomorrow, next Thursday, 3pm, in 2 hours) to absolute values using the provided current time; dates are YYYY-MM-DD, times are 24-hour HH:MM.',
  'For questions (what is due, what can you do), use type none and put the full answer in reply.',
  'Only complete or delete tasks that actually exist in the provided task list; match by name.',
  'If a request is ambiguous or not actionable, use type none with a helpful reply.',
  'Never invent tasks. Use the task list you are given.',
].join('\n');

const PROMPTS = [
  'add task write report for 2 hours tomorrow at 3pm',
  'plan my tomorrow: gym at 7am, standup at 9:30am, deep work 10am to 12pm, lunch at 12:30, review at 2pm',
  'remind me in 45 minutes to call mom',
  'what should I focus on first today?',
  'finish the report',
  'I have a dentist appointment next Thursday at 9am',
];

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function parseJson(content) {
  const text = String(content);
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const first = text.indexOf('{');
  if (first === -1) throw new Error('no JSON object in response');
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(first, i + 1)); }
  }
  throw new Error('unterminated JSON object in response');
}

async function ask(model, request, state) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
      'HTTP-Referer': 'https://localhost',
      'X-Title': 'Halo Assistant',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify({ request, state }) },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: 'HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 240) };
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { raw: content || '(empty)' };
}

(async () => {
  const now = new Date();
  const state = {
    now: now.toISOString(),
    today: dayKey(now),
    tasks: [
      { name: 'write report', due: null, durationMin: 120, done: false, category: null },
      { name: 'reply to emails', due: dayKey(now), durationMin: 30, done: false, category: 'work' },
    ],
    deadlines: [{ name: 'standup', due: dayKey(now), time: '09:30', done: false }],
    categories: ['work', 'personal'],
  };

  for (const prompt of PROMPTS) {
    console.log('\n══════════════════════════════════════');
    console.log('PROMPT:', prompt);
    for (const model of MODELS) {
      try {
        const r = await ask(model, prompt, state);
        if (r.error) { console.log('  ' + model + ' → ' + r.error); continue; }
        console.log('  ' + model + ' → ' + r.raw);
        break; // first model that answers wins (same as the app)
      } catch (e) {
        console.log('  ' + model + ' → error: ' + e.message);
      }
    }
  }
})();
