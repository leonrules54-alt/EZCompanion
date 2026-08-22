// Vercel serverless function: AI proxy for the Halo desktop app.
//
// Holds the master OpenRouter key so end users never need to paste their own.
// Routes each request by entitlement:
//   - Free → free OpenRouter models (rate-limited by OpenRouter, no cost to us)
//   - Pro  → a higher-quality paid model (requires a valid license key)
//
// Required env var (set in Vercel → Settings → Environment Variables):
//   OPENROUTER_API_KEY   your master OpenRouter key (sk-or-…)
// Optional overrides:
//   FREE_MODELS          comma-separated free model list
//   PRO_MODELS           comma-separated paid model list
//
// The app sends the full chat `messages` (system prompt + user request) plus
// the license key. This function only picks a model, attaches the master key,
// and forwards to OpenRouter — prompt/state construction stays in the app.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_FREE_MODELS = [
  'inclusionai/ling-3.0-flash:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];
const DEFAULT_PRO_MODELS = [
  'openai/gpt-4o-mini',
  'anthropic/claude-3-5-haiku',
];

// MOCK license validation. Swap for the real Lemon Squeezy check
// (POST https://api.lemonsqueezy.com/v1/licenses/validate) when billing is live.
function isProLicense(license) {
  const key = String(license || '').trim();
  return /^HALO-PRO-/i.test(key);
}

async function callOpenRouter(apiKey, model, messages) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'HTTP-Referer': 'https://halo-app.vercel.app',
      'X-Title': 'Halo Assistant',
    },
    body: JSON.stringify({ model, temperature: 0, messages }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('OpenRouter HTTP ' + res.status + (text ? ' ' + text.slice(0, 160) : ''));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('empty response from model');
  return String(content);
}

module.exports = async function handler(req, res) {
  // CORS preflight — the Electron renderer calls in from the file:// origin.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ ok: false, error: 'Server not configured (missing OPENROUTER_API_KEY).' });
    return;
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(400).json({ ok: false, error: 'Missing messages.' });
    return;
  }

  const pro = isProLicense(body.license);
  const raw =
    pro
      ? process.env.PRO_MODELS || DEFAULT_PRO_MODELS.join(',')
      : process.env.FREE_MODELS || DEFAULT_FREE_MODELS.join(',');
  const models = raw.split(',').map((s) => s.trim()).filter(Boolean);

  let lastError = null;
  for (const model of models) {
    try {
      const content = await callOpenRouter(apiKey, model, messages);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).json({ ok: true, content, tier: pro ? 'pro' : 'free' });
      return;
    } catch (e) {
      lastError = e;
      // 401/403 → our master key is invalid; no point trying other models.
      if (e.status === 401 || e.status === 403) break;
    }
  }

  const status = lastError && (lastError.status === 401 || lastError.status === 403) ? 502 : 503;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json({ ok: false, error: lastError ? lastError.message : 'AI unavailable' });
};
