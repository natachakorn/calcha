// NubCal shared-key proxy (Cloudflare Worker).
// Holds one Gemini API key as a secret so app users don't need their own.
// The app POSTs { model, request } and gets Gemini's generateContent response back unchanged.
// It also relays OpenAI calls made with the user's own key ({ provider: 'openai', request } plus an
// x-user-key header), because api.openai.com does not answer browsers with CORS headers.
// That key is forwarded for the one request only and never stored or logged.
//
// Secrets / vars (see wrangler.toml):
//   GEMINI_API_KEY   secret — your key from https://aistudio.google.com/apikey
//   ALLOWED_ORIGINS  comma-separated origins allowed to call this worker (your GitHub Pages URL)

const MAX_BODY = 4 * 1024 * 1024; // photos are resized to 1024px in the app, ~200 KB

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-key',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    const fail = (status, message) => json(status, { error: { code: status, message } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return fail(405, 'POST only');
    if (!okOrigin) return fail(403, 'origin not allowed');

    // Per-IP rate limit (optional binding, configured in wrangler.toml).
    if (env.RATE_LIMITER) {
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return fail(429, 'too many requests from this device, slow down');
    }

    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > MAX_BODY) return fail(413, 'request too large');

    let body;
    try { body = await req.json(); } catch { return fail(400, 'invalid JSON'); }
    const { model, request, provider } = body || {};

    if (provider === 'openai') {
      const userKey = req.headers.get('x-user-key') || '';
      if (!/^sk-[\w-]{20,}$/.test(userKey)) return fail(401, 'invalid api key');
      if (!request || !Array.isArray(request.messages)) return fail(400, 'invalid request');
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userKey },
        body: JSON.stringify(request),
      });
      return new Response(upstream.body, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (!env.GEMINI_API_KEY) return fail(500, 'server key not configured');
    if (typeof model !== 'string' || !/^gemini-[\w.-]+$/.test(model)) return fail(400, 'invalid model');
    if (!request || !Array.isArray(request.contents)) return fail(400, 'invalid request');

    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: request.contents, generationConfig: request.generationConfig }),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
