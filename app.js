/* นับแคล NubCal — snap food, get calories & protein.
 * AI: Google Gemini API (free tier) called directly from the device with the user's own key. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------- storage ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('calcha.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('calcha.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('calcha.' + k); } catch {} },
};

const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('calcha', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('meals', { keyPath: 'id' });
        s.createIndex('date', 'date');
      };
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('meals', mode);
      const out = fn(t.objectStore('meals'));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(m) { return this.tx('readwrite', s => s.put(m)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  clear() { return this.tx('readwrite', s => s.clear()); },
};

// v1.1 stored one Gemini model as `model`; settings now keep the key's provider and a model per provider.
function migrateSettings(s) {
  const out = { apiKey: s.apiKey || '', provider: s.provider || '', models: { ...(s.models || {}) } };
  if (s.model && /^gemini/.test(s.model) && !out.models.gemini) out.models.gemini = s.model;
  if (out.apiKey && !out.provider) out.provider = /^sk-ant-/.test(out.apiKey) ? 'claude' : /^sk-/.test(out.apiKey) ? 'openai' : 'gemini';
  return out;
}

const state = {
  profile: LS.get('profile', null),
  settings: migrateSettings(LS.get('settings', {})),
  weights: LS.get('weights', []),
  meals: [],
};

// ---------------- helpers ----------------
const pad = n => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const fmt = n => Math.round(n).toLocaleString('th-TH');
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const thaiDate = (d, opt = { weekday: 'long', day: 'numeric', month: 'long' }) => d.toLocaleDateString('th-TH', opt);
const timeStr = iso => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const MEAL_TYPES = { breakfast: 'เช้า', lunch: 'กลางวัน', dinner: 'เย็น', snack: 'ของว่าง' };
const MEAL_ICONS = { breakfast: 'sunrise', lunch: 'sun', dinner: 'moon', snack: 'cookie' };
const mealLabel = t => (MEAL_TYPES[t] ? ic(MEAL_ICONS[t]) + MEAL_TYPES[t] : '');
function guessMealType(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 10) return 'breakfast';
  if (h >= 11 && h < 14) return 'lunch';
  if (h >= 17 && h < 21) return 'dinner';
  return 'snack';
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------- nutrition targets ----------------
const GOAL_ADJ = { lose: -500, maintain: 0, gain: 300 };
const PROTEIN_PER_KG = { lose: 1.6, maintain: 1.2, gain: 1.8 };

function calcTargets(p) {
  // Mifflin-St Jeor BMR × activity factor
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'male' ? 5 : -161);
  const tdee = bmr * p.activity;
  const floor = p.sex === 'male' ? 1500 : 1200;
  let cal = Math.max(floor, Math.round((tdee + GOAL_ADJ[p.goal]) / 10) * 10);
  let pro = Math.round(p.weight * PROTEIN_PER_KG[p.goal]);
  if (p.customCal > 0) cal = p.customCal;
  if (p.customPro > 0) pro = p.customPro;
  return { cal, pro, bmr: Math.round(bmr), tdee: Math.round(tdee) };
}
const targets = () => calcTargets(state.profile);

function totalsFor(date, excludeId) {
  return state.meals
    .filter(m => m.date === date && m.id !== excludeId)
    .reduce((t, m) => ({ kcal: t.kcal + m.kcal, protein: t.protein + m.protein, carbs: t.carbs + (m.carbs || 0), fat: t.fat + (m.fat || 0), n: t.n + 1 }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0, n: 0 });
}

// ---------------- image processing ----------------
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('อ่านรูปไม่ได้')); };
    img.src = url;
  });
}

function drawScaled(img, maxSide, quality) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// Perceptual signature: 16×16 grayscale, normalised for brightness/contrast.
// Survives re-compression, resizing and sending through chat apps; different dishes score far apart.
function imageSig(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  const v = new Array(256).fill(0);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    v[(y >> 2) * 16 + (x >> 2)] += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 16;
  }
  return v.map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
}
function sigDistance(a, b) {
  if (!a || !b || a.length !== 512 || b.length !== 512) return Infinity;
  const vec = h => { const v = []; for (let i = 0; i < 512; i += 2) v.push(parseInt(h.slice(i, i + 2), 16)); return v; };
  const z = v => {
    const m = v.reduce((x, y) => x + y, 0) / v.length;
    const sd = Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length) || 1;
    return v.map(x => (x - m) / sd);
  };
  const A = z(vec(a)), B = z(vec(b));
  return A.reduce((s, x, i) => s + Math.abs(x - B[i]), 0) / A.length;
}
const SAME_PHOTO = 0.2;
async function sha256(file) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

async function processImage(file) {
  const { img, url } = await loadImage(file);
  try {
    return {
      ai: drawScaled(img, 1024, 0.85),
      thumb: drawScaled(img, 360, 0.72),
      sig: imageSig(img),
      sha: await sha256(file),
    };
  } finally { URL.revokeObjectURL(url); }
}

function findDuplicate(p) {
  let best = null;
  for (const m of state.meals) {
    const exact = p.sha && m.sha === p.sha;
    if (exact || sigDistance(p.sig, m.sig) < SAME_PHOTO) {
      if (!best || m.time > best.time) best = m;
    }
  }
  return best;
}

// ---------------- AI prompt ----------------
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    dish_name: { type: 'STRING', description: 'ชื่ออาหารภาษาไทย สั้นๆ' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          portion: { type: 'STRING', description: 'ปริมาณโดยประมาณ เช่น 1 จาน, 150 g, 1 ฟอง' },
          kcal: { type: 'NUMBER' },
          protein_g: { type: 'NUMBER' },
        },
        required: ['name', 'portion', 'kcal', 'protein_g'],
      },
    },
    total_kcal: { type: 'NUMBER' },
    protein_g: { type: 'NUMBER' },
    carbs_g: { type: 'NUMBER' },
    fat_g: { type: 'NUMBER' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    tip: { type: 'STRING', description: 'คำแนะนำสั้นๆ 1 ประโยคเป็นภาษาไทย' },
  },
  required: ['is_food', 'dish_name', 'items', 'total_kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence', 'tip'],
};

function buildPrompt(kind, text) {
  const src = kind === 'photo'
    ? 'วิเคราะห์อาหารในรูปนี้'
    : `วิเคราะห์อาหารจากคำบรรยายนี้: "${text}"`;
  return `${src}
คุณเป็นนักโภชนาการที่เชี่ยวชาญอาหารไทยและอาหารทั่วไป
- ระบุอาหารแต่ละอย่างที่เห็น ประมาณปริมาณที่เสิร์ฟจริงตามขนาดภาชนะ (ใช้ขนาดจานมาตรฐานร้านอาหารไทยถ้าไม่แน่ใจ)
- คิดรวมน้ำมันที่ใช้ปรุง น้ำซุป ซอส น้ำจิ้ม และเครื่องดื่มที่เห็น
- ให้ค่าแคลอรี่ (kcal) โปรตีน คาร์บ ไขมัน (กรัม) ของทั้งมื้อ ตัวเลขต้องสมเหตุสมผลและผลรวม items ต้องเท่ากับ total
- ถ้าไม่ใช่อาหารหรือเครื่องดื่ม ให้ is_food=false และใส่ค่าเป็น 0
- ชื่ออาหารและคำแนะนำเป็นภาษาไทย
${userContext()}`;
}

// Today's targets and intake so the AI can tailor its tip (absent during onboarding).
function userContext() {
  if (!state.profile) return '';
  const t = targets();
  const eaten = totalsFor(dateKey());
  return `
- ข้อมูลผู้ใช้: เป้าหมายวันนี้ ${t.cal} kcal, โปรตีน ${t.pro} g, กินไปแล้ว ${Math.round(eaten.kcal)} kcal, โปรตีน ${Math.round(eaten.protein)} g
  ใช้ข้อมูลนี้ให้ tip ที่เป็นประโยชน์ (เช่น ควรเพิ่มโปรตีน หรือมื้อนี้ค่อนข้างหนัก)`;
}

class AIError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

const PROXY_URL = (window.CALCHA_CONFIG && window.CALCHA_CONFIG.proxyUrl) || '';
// AI works if the user has their own key, or the app is deployed with a shared-key proxy.
const aiAvailable = () => !!(state.settings.apiKey || PROXY_URL);

// ---------------- AI providers ----------------
// Users can bring a key from Google Gemini, Anthropic Claude or OpenAI; the key's prefix says which.
// Without a key the app uses the shared Gemini proxy (config.js).
const MODEL_TIMEOUT_MS = 25000;
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini', free: true, keyUrl: 'https://aistudio.google.com/apikey',
    // '-latest' aliases follow Google's newest release; tried in order when busy (503) or retired (404).
    models: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite'],
  },
  claude: {
    label: 'Claude', free: false, keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  openai: {
    label: 'ChatGPT (OpenAI)', free: false, keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'],
  },
};
function detectProvider(key) {
  if (/^sk-ant-/.test(key)) return 'claude';
  if (/^sk-/.test(key)) return 'openai';
  return 'gemini';
}
const activeProvider = () => (state.settings.apiKey ? state.settings.provider || detectProvider(state.settings.apiKey) : 'gemini');

// Gemini's schema dialect (UPPERCASE types) → standard JSON Schema for Claude / OpenAI.
function toJsonSchema(s) {
  const out = { type: s.type.toLowerCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = s.required || Object.keys(s.properties);
    out.additionalProperties = false;
  }
  return out;
}
const JSON_SCHEMA = toJsonSchema(SCHEMA);

// Each adapter turns { prompt, image } into a fetch request and pulls the JSON text out of the reply.
const ADAPTERS = {
  gemini: {
    request(model, { prompt, image }, key) {
      const parts = image ? [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: prompt }] : [{ text: prompt }];
      const request = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
      };
      return key
        ? { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': key }, body: request }
        : { url: PROXY_URL, headers: {}, body: { model, request } };
    },
    text: body => (body.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''),
  },
  claude: {
    request(model, { prompt, image }, key) {
      const content = image
        ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text: prompt }]
        : [{ type: 'text', text: prompt }];
      // Haiku has no server-side refusal fallback; Opus/Sonnet reroute a declined request themselves.
      const fallback = !/haiku/.test(model);
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2026-10-21',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
        },
        body: {
          model,
          max_tokens: 16000,
          messages: [{ role: 'user', content }],
          // Reading a plate is a quick judgement call, so keep thinking short.
          output_config: { effort: 'low', format: { type: 'json_schema', schema: JSON_SCHEMA } },
          ...(fallback ? { fallbacks: 'default' } : {}),
        },
      };
    },
    text(body) {
      if (body.stop_reason === 'refusal') throw new AIError('Claude ไม่ตอบคำขอนี้ ลองรูปอื่น หรือเลือกเมนูจากรายการแทน', 'empty');
      return (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    },
  },
  openai: {
    request(model, { prompt, image }, key) {
      const text = `${prompt}\nตอบเป็น JSON เท่านั้น ตาม JSON Schema นี้: ${JSON.stringify(JSON_SCHEMA)}`;
      const content = image
        ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } }]
        : text;
      const request = { model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' } };
      // api.openai.com sends no CORS headers to browsers, so go through the worker when there is one.
      return PROXY_URL
        ? { url: PROXY_URL, headers: { 'x-user-key': key }, body: { provider: 'openai', request } }
        : { url: 'https://api.openai.com/v1/chat/completions', headers: { Authorization: 'Bearer ' + key }, body: request };
    },
    text(body) {
      const msg = body.choices?.[0]?.message || {};
      if (msg.refusal) throw new AIError('ChatGPT ไม่ตอบคำขอนี้ ลองรูปอื่น หรือเลือกเมนูจากรายการแทน', 'empty');
      return msg.content || '';
    },
  },
};

// input: { prompt, image? (base64 JPEG) }. opts.key tests a specific key before it is saved.
async function callAI(input, opts = {}) {
  const key = opts.key || state.settings.apiKey;
  const viaProxy = !key && PROXY_URL;
  if (!key && !viaProxy) throw new AIError('ยังไม่ได้เชื่อมต่อ AI', 'nokey');
  const provider = key ? (opts.key ? detectProvider(key) : activeProvider()) : 'gemini';
  const { label, free } = PROVIDERS[provider];
  const chosen = (state.settings.models || {})[provider];
  const models = [...new Set([chosen, ...PROVIDERS[provider].models].filter(Boolean))];
  const adapter = ADAPTERS[provider];
  let lastErr;
  for (const model of models) {
    const req = adapter.request(model, input, key);
    // A model under heavy load can hang instead of answering 503, so give each one a time limit.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MODEL_TIMEOUT_MS);
    let r, body;
    try {
      r = await fetch(req.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
      });
      body = await r.json().catch(() => ({}));
    } catch (e) {
      if (e.name === 'AbortError') { lastErr = new AIError('AI ตอบช้าเกินไป ลองใหม่อีกครั้ง', 'busy'); continue; }
      throw new AIError('เชื่อมต่ออินเทอร์เน็ตไม่ได้ ลองใหม่อีกครั้ง', 'network');
    } finally {
      clearTimeout(timer);
    }
    if (r.ok) {
      const txt = adapter.text(body);
      if (!txt) throw new AIError('AI ไม่ตอบกลับ (อาจถูกบล็อกเนื้อหา) ลองรูปอื่น', 'empty');
      try { return JSON.parse(txt.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new AIError('อ่านผลจาก AI ไม่ได้ ลองใหม่อีกครั้ง', 'parse'); }
    }
    const err = body.error || {};
    const msg = (typeof err === 'string' ? err : err.message) || r.statusText;
    const code = err.code || err.type || '';
    if (r.status === 404 || code === 'model_not_found' || (r.status === 400 && /model/i.test(msg) && !/key|credit/i.test(msg))) {
      lastErr = new AIError(msg, 'model'); continue;
    }
    // Gemini's free tier counts quota per model, so a 429 there just means "try the next model".
    if (r.status === 429 && provider === 'gemini') {
      lastErr = new AIError(viaProxy
        ? 'AI ส่วนกลางมีคนใช้เยอะ โควต้าวันนี้เต็มแล้ว ลองใหม่พรุ่งนี้ หรือใส่คีย์ฟรีของคุณเองได้ในหน้า "ข้อมูลฉัน"'
        : 'คีย์ Gemini ของคุณใช้ครบโควต้าฟรีของวันนี้แล้ว ลองใหม่ภายหลัง', 'quota');
      continue;
    }
    if (!free && /credit balance|insufficient_quota|billing/i.test(msg + ' ' + code)) {
      throw new AIError(`บัญชี ${label} ของคุณยังไม่มีเครดิต — คีย์ ${label} ต้องเติมเงินก่อนใช้งาน (ไม่ฟรี) หรือใช้คีย์ Google Gemini ที่ฟรีแทน`, 'credit');
    }
    if (r.status === 401 || r.status === 403 || /api.?key|authentication/i.test(msg)) {
      throw viaProxy
        ? new AIError('AI ส่วนกลางของแอปใช้งานไม่ได้ตอนนี้ ใส่คีย์ของคุณเองได้ในหน้า "ข้อมูลฉัน"', 'proxy')
        : new AIError(`คีย์ ${label} ไม่ถูกต้อง กรุณาตรวจสอบในหน้า "ข้อมูลฉัน"`, 'badkey');
    }
    if (r.status === 429) {
      throw viaProxy
        ? new AIError('AI ส่วนกลางมีคนใช้เยอะ โควต้าเต็มชั่วคราว ลองใหม่ภายหลัง หรือใส่คีย์ของคุณเองได้ในหน้า "ข้อมูลฉัน"', 'quota')
        : new AIError(free ? 'ใช้ AI ฟรีครบโควต้าแล้วชั่วคราว รอสักครู่แล้วลองใหม่' : `${label} จำกัดจำนวนครั้งชั่วคราว รอสักครู่แล้วลองใหม่`, 'quota');
    }
    if ([500, 502, 503, 529].includes(r.status)) { lastErr = new AIError('เซิร์ฟเวอร์ AI ไม่ว่าง ลองใหม่อีกครั้ง', 'busy'); continue; }
    throw new AIError(msg, 'other');
  }
  throw lastErr || new AIError('ไม่พบโมเดลที่ใช้งานได้', 'model');
}

// ---------------- easy key setup ----------------
// Pull the key out of whatever was pasted: a bare key, quoted text, or a whole copied line.
// The provider decides validity; we only reject text that cannot possibly be a key.
function extractKey(raw) {
  const text = (raw || '').trim();
  const known = text.match(/sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}/);
  if (known) return known[0];
  const tokens = text.match(/[A-Za-z0-9._~+/=-]{30,}/g);
  return tokens ? tokens.sort((a, b) => b.length - a.length)[0] : null;
}
const maskKey = k => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);

// Renders: open-Google button → paste button (reads clipboard) → auto test → saved.
function keyBox(el, onValid) {
  el.innerHTML = `
    <div class="keybox">
      <a class="kb-step" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">
        <span class="kb-n">1</span><span><b>เปิดหน้า Google รับคีย์ฟรี</b><small>ล็อกอิน Google → กด "Create API key" → กดไอคอนคัดลอกข้างคีย์</small></span><span class="kb-go">${ic('external')}</span>
      </a>
      <button type="button" class="kb-step kb-paste">
        <span class="kb-n">2</span><span><b>กลับมากดตรงนี้เพื่อวางคีย์</b><small>แอปรู้เองว่าเป็นคีย์ของเจ้าไหน และตรวจสอบให้อัตโนมัติ</small></span><span class="kb-go">${ic('clipboard')}</span>
      </button>
      <p class="kb-alt tiny muted">มีคีย์ <a href="${PROVIDERS.claude.keyUrl}" target="_blank" rel="noopener">Claude</a> หรือ <a href="${PROVIDERS.openai.keyUrl}" target="_blank" rel="noopener">ChatGPT (OpenAI)</a> อยู่แล้ว? วางในข้อ 2 ได้เลย — สองเจ้านี้คิดเงินตามการใช้งาน ต้องเติมเครดิตในบัญชีก่อน</p>
      <div class="kb-field">
        <input class="text-input kb-input" type="password" placeholder="หรือกดค้างแล้ววางคีย์ตรงนี้" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button type="button" class="kb-eye" aria-label="แสดงคีย์">${ic('eye')}</button>
      </div>
      <p class="kb-status small" aria-live="polite"></p>
    </div>`;
  const input = $('.kb-input', el), status = $('.kb-status', el);
  const setStatus = (cls, txt) => { status.className = 'kb-status small ' + cls; status.textContent = txt; };
  $('.kb-eye', el).onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; };
  let busy = false;
  async function check(raw) {
    if (!(raw || '').trim() || busy) return;
    const key = extractKey(raw);
    if (!key) return setStatus('bad', 'ข้อความที่วางไม่ใช่คีย์ — ที่หน้า Google ให้กดไอคอนคัดลอกข้างคีย์ แล้วกลับมากดปุ่ม 2 อีกครั้ง');
    input.value = key;
    busy = true;
    const provider = detectProvider(key), { label } = PROVIDERS[provider];
    setStatus('wait', `พบคีย์ ${label} ${maskKey(key)} — กำลังตรวจสอบ…`);
    try {
      await callAI({ prompt: buildPrompt('text', 'ไข่ต้ม 1 ฟอง') }, { key });
      state.settings.apiKey = key;
      state.settings.provider = provider;
      LS.set('settings', state.settings);
      setStatus('ok', `เชื่อมต่อ ${label} สำเร็จ พร้อมใช้งานแล้ว`);
      onValid && onValid();
    } catch (err) {
      setStatus('bad', err.code === 'badkey'
        ? `${label} แจ้งว่าคีย์ ${maskKey(key)} ใช้ไม่ได้ — กดรูปตาเพื่อเช็คว่าวางครบ หรือสร้างคีย์ใหม่แล้วคัดลอกอีกครั้ง`
        : err.message);
    } finally { busy = false; }
  }
  $('.kb-paste', el).onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return setStatus('bad', 'คลิปบอร์ดว่าง — กลับไปกดคัดลอกคีย์ที่หน้า Google ก่อน');
      check(t);
    } catch {
      input.focus();
      setStatus('', 'เบราว์เซอร์ไม่อนุญาตให้อ่านคลิปบอร์ด — กดค้างที่ช่องด้านบนแล้วเลือก "วาง"');
    }
  };
  input.addEventListener('paste', () => setTimeout(() => check(input.value), 0));
  input.addEventListener('change', () => check(input.value));
  if (state.settings.apiKey) { input.value = state.settings.apiKey; setStatus('ok', 'ใส่คีย์แล้ว'); }
}

function normalize(a) {
  const n = v => Math.max(0, Math.round(Number(v) || 0));
  return {
    is_food: a.is_food !== false,
    name: a.dish_name || 'อาหาร',
    items: (a.items || []).map(i => ({ name: i.name, portion: i.portion || '', kcal: n(i.kcal), protein: n(i.protein_g) })),
    kcal: n(a.total_kcal), protein: n(a.protein_g), carbs: n(a.carbs_g), fat: n(a.fat_g),
    confidence: a.confidence || 'medium',
    tip: a.tip || '',
  };
}

// ---------------- sheet ----------------
function openSheet(html) {
  const sh = $('#sheet');
  sh.onclick = null;
  sh.innerHTML = '<div class="grab"></div>' + html;
  sh.hidden = false; $('#sheetBackdrop').hidden = false;
  sh.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  return sh;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true;
  document.body.style.overflow = '';
}

// ---------------- analysis flows ----------------
async function handleFile(file) {
  if (!file) return;
  let p;
  try { p = await processImage(file); }
  catch { toast('เปิดรูปนี้ไม่ได้ ลองเลือกรูปอื่น'); return; }

  const dup = findDuplicate(p);
  if (dup) return showDuplicate(dup, p);
  analyzePhoto(p);
}

function showDuplicate(dup, p) {
  const when = dup.date === dateKey() ? `วันนี้ ${timeStr(dup.time)}` : `${thaiDate(parseKey(dup.date), { day: 'numeric', month: 'short' })} ${timeStr(dup.time)}`;
  const sh = openSheet(`
    <div class="sheet-ic warn">${ic('copy')}</div><h2>รูปนี้เคยส่งแล้ว</h2>
    <p class="muted small">ส่งไปเมื่อ <b>${when}</b> — ${esc(dup.name)} (${fmt(dup.kcal)} kcal)</p>
    <div class="dup-imgs">
      <figure><img src="${dup.thumb}" alt=""><figcaption>ที่บันทึกไว้</figcaption></figure>
      <figure><img src="${p.thumb}" alt=""><figcaption>รูปที่ส่งตอนนี้</figcaption></figure>
    </div>
    <p><b>เป็นมื้อเดิม หรือมื้อใหม่?</b></p>
    <button class="btn ghost block" data-a="same">${ic('repeat')}มื้อเดิม — ไม่ต้องนับซ้ำ</button>
    <button class="btn primary block" data-a="new">${ic('plus')}มื้อใหม่ — กินอีกครั้ง นับเพิ่ม</button>
    <button class="btn plain block" data-a="reanalyze">${ic('scan')}เป็นอาหารอื่น ให้ AI วิเคราะห์ใหม่</button>
  `);
  sh.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    sh.onclick = null;
    if (a === 'same') { closeSheet(); toast('โอเค ไม่นับซ้ำ'); }
    else if (a === 'new') {
      const base = dup.base || { name: dup.name, items: dup.items, kcal: dup.kcal, protein: dup.protein, carbs: dup.carbs, fat: dup.fat, confidence: dup.confidence, tip: '' };
      showResult({ analysis: { ...base, is_food: true }, thumb: p.thumb, sig: p.sig, sha: p.sha, source: dup.source || 'photo', portion: dup.portion || 1 });
    } else analyzePhoto(p);
  };
}

async function analyzePhoto(p) {
  if (!aiAvailable()) return showNoKey(p);
  openSheet(`<div class="loading"><img src="${p.thumb}" alt=""><div class="spinner"></div><b>AI กำลังดูจานของคุณ…</b><p class="small muted">ประมาณ 3–10 วินาที</p></div>`);
  try {
    const raw = await callAI({ prompt: buildPrompt('photo'), image: p.ai.split(',')[1] });
    const a = normalize(raw);
    if (!a.is_food) return showError('ดูเหมือนในรูปจะไม่ใช่อาหาร ลองถ่ายใหม่ให้เห็นจานชัดๆ', p);
    showResult({ analysis: a, thumb: p.thumb, sig: p.sig, sha: p.sha, source: 'photo', portion: 1 });
  } catch (err) {
    showError(err.message, p, err.code);
  }
}

// ---------------- food search (works without AI) ----------------
const EMPTY_ANALYSIS = () => ({ name: '', items: [], kcal: 0, protein: 0, carbs: 0, fat: 0, confidence: 'high', tip: '' });
const photoCtx = p => (p ? { thumb: p.thumb, sig: p.sig, sha: p.sha } : {});

function foodToAnalysis(f) {
  const [name, serving, kcal, protein, carbs, fat] = f;
  return { name, items: [{ name, portion: serving, kcal, protein }], kcal, protein, carbs, fat, confidence: 'high', tip: '' };
}

function searchFoods(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  window.FOODS.forEach((f, i) => {
    const name = f[0].toLowerCase();
    const hay = name + ' ' + f[1] + ' ' + (f[6] || '').toLowerCase();
    if (!words.every(w => hay.includes(w))) return;
    const score = name.startsWith(words[0]) ? 0 : name.includes(words[0]) ? 1 : 2;
    out.push({ i, score });
  });
  return out.sort((x, y) => x.score - y.score || x.i - y.i).slice(0, 40).map(x => x.i);
}

// Recently eaten dishes (unique by name) for one-tap re-logging.
function recentMeals(limit = 6) {
  const seen = new Set(), out = [];
  for (const m of [...state.meals].sort((a, b) => b.time.localeCompare(a.time))) {
    if (seen.has(m.name)) continue;
    seen.add(m.name); out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

function showFoodSearch(p) {
  const ai = aiAvailable();
  const sh = openSheet(`
    ${p ? `<div class="search-photo"><img src="${p.thumb}" alt=""><div><b>เลือกเมนูที่ตรงกับรูป</b><p class="small muted">ค้นหาจากรายการอาหารไทยในแอป</p></div></div>` : `<h2 class="with-ic">${ic('search')}ค้นหาเมนู</h2>`}
    <input id="foodQ" class="text-input" type="search" placeholder="พิมพ์ชื่อเมนู เช่น กะเพรา, ชาเย็น, ส้มตำ" autocomplete="off">
    <div id="foodResults" class="food-results"></div>
    <button class="btn plain block" data-a="manual">${ic('pencil')}ใส่ตัวเลขเอง</button>
  `);
  const row = i => {
    const f = window.FOODS[i];
    return `<button class="food-row" data-food="${i}"><span>${esc(f[0])} <span class="muted">· ${esc(f[1])}</span></span><small>${fmt(f[2])} kcal · P ${fmt(f[3])} g</small></button>`;
  };
  const render = () => {
    const q = $('#foodQ').value.trim();
    let html = '';
    if (q && ai) html += `<button class="food-row ai" data-a="ai"><span>${ic('sparkles')}ให้ AI คำนวณ "${esc(q)}"</span><small>ใส่ปริมาณได้ เช่น "ข้าวมันไก่ 2 จาน + น้ำซุป"</small></button>`;
    let list;
    if (!q) {
      const rec = recentMeals();
      if (rec.length) html += '<p class="fr-head">กินบ่อย / ล่าสุด</p>' + rec.map(m => `<button class="food-row" data-recent="${m.id}"><span>${esc(m.name)}</span><small>${fmt(m.kcal)} kcal · P ${fmt(m.protein)} g</small></button>`).join('');
      html += '<p class="fr-head">เมนูยอดนิยม</p>';
      list = window.FOODS.slice(0, 25).map((_, i) => i);
    } else list = searchFoods(q);
    html += list.map(row).join('');
    if (q && !list.length) html += `<p class="small muted center">ไม่พบ "${esc(q)}" ในรายการ${ai ? ' — กดให้ AI คำนวณด้านบน' : ' — ลองคำอื่น หรือใส่ตัวเลขเอง'}</p>`;
    $('#foodResults').innerHTML = html;
  };
  $('#foodQ').addEventListener('input', render);
  $('#foodQ').addEventListener('keydown', e => { if (e.key === 'Enter' && ai && e.target.value.trim()) aiText(e.target.value.trim(), p); });
  render();
  if (!p) setTimeout(() => $('#foodQ')?.focus(), 250);
  sh.onclick = e => {
    const el = e.target.closest('[data-food],[data-recent],[data-a]');
    if (!el) return;
    if (el.dataset.food) return showResult({ analysis: foodToAnalysis(window.FOODS[+el.dataset.food]), ...photoCtx(p), source: 'db', portion: 1 });
    if (el.dataset.recent) {
      const m = state.meals.find(x => x.id === el.dataset.recent);
      const base = m.base || { name: m.name, items: m.items, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, confidence: m.confidence };
      return showResult({ analysis: { ...base, tip: '' }, ...photoCtx(p), source: m.source === 'photo' ? 'text' : m.source, portion: m.portion || 1 });
    }
    if (el.dataset.a === 'ai') return aiText($('#foodQ').value.trim(), p);
    if (el.dataset.a === 'manual') return showResult({ analysis: EMPTY_ANALYSIS(), ...photoCtx(p), source: 'manual', portion: 1, editing: true });
  };
}

async function aiText(text, p) {
  openSheet(`<div class="loading"><div class="spinner"></div><b>กำลังคำนวณ "${esc(text)}"…</b></div>`);
  try {
    const a = normalize(await callAI({ prompt: buildPrompt('text', text) }));
    if (!a.is_food) return showError('ไม่แน่ใจว่าเป็นอาหารอะไร ลองพิมพ์ให้ละเอียดขึ้น');
    showResult({ analysis: a, ...photoCtx(p), source: 'text', portion: 1 });
  } catch (err) { showError(err.message, null, err.code); }
}

function showNoKey(p) {
  const sh = openSheet(`
    ${p ? `<img class="res-photo" src="${p.thumb}" alt="" style="max-height:150px">` : ''}
    <h2 class="with-ic" style="margin-top:12px">${ic('sparkles')}เปิดใช้ AI ดูรูปอาหาร</h2>
    <p class="muted small">ทำครั้งเดียว ใช้ได้ตลอด — ฟรี ใช้แค่บัญชี Google</p>
    <div id="nkKeyBox"></div>
    <button class="btn ghost block" data-a="search">${ic('list')}เลือกเมนูจากรายการแทน (ไม่ต้องใช้ AI)</button>
  `);
  keyBox($('#nkKeyBox', sh), () => {
    if (p) setTimeout(() => analyzePhoto(p), 700);
    else { toast('เชื่อมต่อ AI แล้ว'); closeSheet(); }
  });
  sh.onclick = e => { if (e.target.closest('[data-a="search"]')) showFoodSearch(p); };
}

function showError(msg, p, code) {
  const sh = openSheet(`
    <div class="sheet-ic bad">${ic('alert')}</div><h2>ขออภัย</h2>
    <p>${esc(msg)}</p>
    ${p ? '<button class="btn primary block" data-a="retry">ลองใหม่</button>' : ''}
    ${['badkey', 'proxy', 'quota'].includes(code) ? `<button class="btn ghost block" data-a="key">${ic('key')}ใส่ / เปลี่ยนคีย์ของฉัน</button>` : ''}
    <button class="btn ghost block" data-a="search">${ic('list')}เลือกเมนูจากรายการแทน</button>
    <button class="btn plain block" data-a="close">ปิด</button>
  `);
  sh.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'retry') analyzePhoto(p);
    if (a === 'key') showNoKey(p);
    if (a === 'search') showFoodSearch(p);
    if (a === 'close') closeSheet();
  };
}

// ---------------- result / meal detail ----------------
const PORTIONS = [[0.5, '½'], [1, '1 ที่'], [1.5, '1½'], [2, '2 ที่']];
const CONF = { low: 'ความมั่นใจต่ำ', medium: 'ความมั่นใจปานกลาง', high: 'ความมั่นใจสูง' };

function impactRow(label, unit, before, add, target, cls) {
  const total = before + add;
  const over = total > target;
  const wA = Math.min(100, pct(before, target));
  const wB = Math.max(0, Math.min(100 - wA, pct(add, target)));
  const left = target - total;
  return `
    <div class="imp-row">
      <div class="imp-top"><span>${label} มื้อนี้ <b>${pct(add, target)}%</b> ของวัน</span><b>${fmt(total)} / ${fmt(target)} ${unit}</b></div>
      <div class="stack-bar ${cls}"><div class="a" style="width:${wA}%"></div><div class="b ${over ? 'over' : ''}" style="width:${wB}%"></div></div>
      <div class="imp-sub">${over ? `${ic('alert')}รวมแล้วเกินเป้า ${fmt(-left)} ${unit}` : `รวมทั้งวัน ${pct(total, target)}% · เหลืออีก ${fmt(left)} ${unit}`}</div>
    </div>`;
}

function showResult(ctx) {
  const t = ctx.existing ? (ctx.existing.target || targets()) : targets();
  const date = ctx.existing ? ctx.existing.date : dateKey();
  const before = totalsFor(date, ctx.existing?.id);
  ctx.type = ctx.type || guessMealType();
  const a = ctx.analysis;
  const k = ctx.portion;
  const cur = { kcal: a.kcal * k, protein: a.protein * k, carbs: a.carbs * k, fat: a.fat * k };
  const isToday = date === dateKey();

  const itemsHtml = a.items.length
    ? `<ul class="res-items">${a.items.map(i => `<li><span>${esc(i.name)} <span class="muted">· ${esc(i.portion)}</span></span><span>${fmt(i.kcal * k)} kcal · P ${fmt(i.protein * k)} g</span></li>`).join('')}</ul>`
    : '';

  const editHtml = ctx.editing ? `
    <div class="card form" style="box-shadow:none;background:var(--bg);padding:12px">
      <label class="lbl" style="margin-top:0">ชื่ออาหาร</label>
      <input class="text-input" id="edName" value="${esc(a.name)}" placeholder="เช่น ข้าวกะเพราไก่ไข่ดาว">
      <div class="row2">
        <label>แคลอรี่ (kcal)<input class="text-input" id="edKcal" type="number" inputmode="numeric" value="${a.kcal || ''}"></label>
        <label>โปรตีน (g)<input class="text-input" id="edPro" type="number" inputmode="numeric" value="${a.protein || ''}"></label>
        <label>คาร์บ (g)<input class="text-input" id="edCarb" type="number" inputmode="numeric" value="${a.carbs || ''}"></label>
        <label>ไขมัน (g)<input class="text-input" id="edFat" type="number" inputmode="numeric" value="${a.fat || ''}"></label>
      </div>
      <p class="tiny muted">ตัวเลขนี้คือ 1 ที่ (ก่อนคูณจำนวนที่)</p>
      <button class="btn ghost block" id="edApply">ใช้ตัวเลขนี้</button>
    </div>` : '';

  const sh = openSheet(`
    ${ctx.thumb ? `<img class="res-photo" src="${ctx.thumb}" alt="">` : ''}
    <div class="res-title">${esc(a.name || 'ใส่ข้อมูลอาหาร')}</div>
    ${ctx.source === 'db' ? `<span class="conf">${ic('book')}ค่าเฉลี่ยจากรายการอาหารในแอป</span>` : ctx.source !== 'manual' ? `<span class="conf">${ic('sparkles')}${CONF[a.confidence] || ''}</span>` : ''}
    ${editHtml}
    <div class="macros">
      <div class="macro cal"><div class="v">${fmt(cur.kcal)}</div><div class="l">kcal</div></div>
      <div class="macro pro"><div class="v">${fmt(cur.protein)}<small>g</small></div><div class="l">โปรตีน</div></div>
      <div class="macro"><div class="v">${fmt(cur.carbs)}<small>g</small></div><div class="l">คาร์บ</div></div>
      <div class="macro"><div class="v">${fmt(cur.fat)}<small>g</small></div><div class="l">ไขมัน</div></div>
    </div>
    <p class="small muted" style="margin:0 0 4px">กินไปกี่ที่?</p>
    <div class="portion">${PORTIONS.map(([v, l]) => `<button data-portion="${v}" class="${v === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="impact">
      <h4>${ic('chart')}${ctx.existing ? 'มื้อนี้ในวันนั้น' : `ถ้ากินมื้อนี้ ${isToday ? 'วันนี้' : ''}จะเป็น…`}</h4>
      ${impactRow(ic('flame') + 'แคล', 'kcal', before.kcal, cur.kcal, t.cal, 'cal')}
      ${impactRow(ic('drumstick') + 'โปรตีน', 'g', before.protein, cur.protein, t.pro, 'pro')}
    </div>
    ${a.tip ? `<div class="tip">${ic('bulb')}<span>${esc(a.tip)}</span></div>` : ''}
    ${itemsHtml ? `<details ${a.items.length <= 4 ? 'open' : ''}><summary class="small muted">รายละเอียดในจาน</summary>${itemsHtml}</details>` : ''}
    <p class="small muted" style="margin:14px 0 6px">มื้อ</p>
    <div class="mealtype">${Object.keys(MEAL_TYPES).map(v => `<button data-type="${v}" class="${v === ctx.type ? 'on' : ''}">${mealLabel(v)}</button>`).join('')}</div>
    ${!ctx.editing ? `<button class="btn plain block" id="rsEdit">${ic('pencil')}แก้ไขตัวเลข</button>` : ''}
    <button class="btn primary block" id="rsSave">${ic('check')}${ctx.existing ? 'บันทึกการแก้ไข' : 'บันทึกว่ากินมื้อนี้'}</button>
    ${ctx.existing ? `<button class="btn danger block" id="rsDel">${ic('trash')}ลบมื้อนี้</button>` : ''}
    <button class="btn plain block" id="rsCancel">${ctx.existing ? 'ปิด' : 'ยังไม่กิน / ยกเลิก'}</button>
  `);

  const rerender = () => { const y = sh.scrollTop; showResult(ctx); $('#sheet').scrollTop = y; };
  sh.onclick = e => {
    const pb = e.target.closest('[data-portion]');
    if (pb) { ctx.portion = Number(pb.dataset.portion); return rerender(); }
    const tb = e.target.closest('[data-type]');
    if (tb) { ctx.type = tb.dataset.type; $$('.mealtype button', sh).forEach(b => b.classList.toggle('on', b === tb)); }
  };
  $('#rsEdit', sh)?.addEventListener('click', () => { ctx.editing = true; rerender(); });
  $('#edApply', sh)?.addEventListener('click', () => {
    readEdits(ctx); ctx.editing = false; rerender();
  });
  $('#rsCancel', sh).onclick = closeSheet;
  $('#rsDel', sh)?.addEventListener('click', async () => {
    if (!confirm('ลบมื้อนี้?')) return;
    await DB.del(ctx.existing.id);
    state.meals = state.meals.filter(m => m.id !== ctx.existing.id);
    closeSheet(); renderAll(); toast('ลบแล้ว');
  });
  $('#rsSave', sh).onclick = async () => {
    if (ctx.editing) readEdits(ctx);
    const a2 = ctx.analysis;
    if (!a2.name) a2.name = 'อาหาร';
    if (!(a2.kcal > 0)) return toast('ใส่จำนวนแคลอรี่ก่อนนะ');
    const k2 = ctx.portion;
    const meal = {
      ...(ctx.existing || {}),
      id: ctx.existing?.id || uid(),
      date,
      time: ctx.existing?.time || new Date().toISOString(),
      type: ctx.type,
      name: a2.name,
      items: a2.items.map(i => ({ ...i, kcal: Math.round(i.kcal * k2), protein: Math.round(i.protein * k2) })),
      kcal: Math.round(a2.kcal * k2), protein: Math.round(a2.protein * k2),
      carbs: Math.round(a2.carbs * k2), fat: Math.round(a2.fat * k2),
      confidence: a2.confidence,
      portion: k2,
      base: { name: a2.name, items: a2.items, kcal: a2.kcal, protein: a2.protein, carbs: a2.carbs, fat: a2.fat, confidence: a2.confidence, tip: a2.tip },
      thumb: ctx.thumb || ctx.existing?.thumb || null,
      sig: ctx.sig || ctx.existing?.sig || null,
      sha: ctx.sha || ctx.existing?.sha || null,
      source: ctx.source,
      target: ctx.existing?.target || { cal: t.cal, pro: t.pro },
    };
    await DB.put(meal);
    const i = state.meals.findIndex(m => m.id === meal.id);
    if (i >= 0) state.meals[i] = meal; else state.meals.push(meal);
    closeSheet(); renderAll();
    switchTab('today');
    toast(ctx.existing ? 'บันทึกการแก้ไขแล้ว' : `บันทึกแล้ว +${fmt(meal.kcal)} kcal, +${fmt(meal.protein)} g โปรตีน`);
  };
}

function readEdits(ctx) {
  const v = id => Math.max(0, Math.round(Number($(id)?.value) || 0));
  const a = ctx.analysis;
  const name = $('#edName')?.value.trim();
  const nk = v('#edKcal'), np = v('#edPro');
  const changed = nk !== a.kcal || np !== a.protein;
  ctx.analysis = { ...a, name: name || a.name, kcal: nk, protein: np, carbs: v('#edCarb'), fat: v('#edFat'), items: changed ? [] : a.items };
}

function openMeal(id) {
  const m = state.meals.find(x => x.id === id);
  if (!m) return;
  const base = m.base || { name: m.name, items: m.items, kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, confidence: m.confidence, tip: '' };
  showResult({ analysis: { ...base, tip: '' }, thumb: m.thumb, sig: m.sig, sha: m.sha, source: m.source, portion: m.portion || 1, type: m.type, existing: m });
}

// ---------------- render: today ----------------
function mealCard(m) {
  return `<button class="meal" data-meal="${m.id}">
    ${m.thumb ? `<img src="${m.thumb}" alt="">` : `<div class="noimg">${ic('utensils')}</div>`}
    <div class="info"><div class="name">${esc(m.name)}</div><div class="meta">${mealLabel(m.type)} · ${timeStr(m.time)}${m.portion && m.portion !== 1 ? ` · ×${m.portion}` : ''}</div></div>
    <div class="nums"><div class="k">${fmt(m.kcal)}</div><div class="p">P ${fmt(m.protein)} g</div></div>
  </button>`;
}

function renderToday() {
  const now = new Date();
  const key = dateKey(now);
  const t = targets();
  const s = totalsFor(key);
  const h = now.getHours();
  $('#todayLabel').textContent = thaiDate(now);
  $('#greet').innerHTML = (h < 11 ? 'อรุณสวัสดิ์' : h < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น') + ic(h >= 5 && h < 18 ? 'sun' : 'moon', 'greet-ic');

  const left = t.cal - s.kcal;
  const p = pct(s.kcal, t.cal);
  const C = 2 * Math.PI * 52;
  const ring = $('#calRing');
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.min(1, s.kcal / t.cal));
  ring.classList.toggle('over', left < 0);
  $('#calLeft').textContent = fmt(Math.abs(left));
  $('#calLeftLabel').textContent = left >= 0 ? 'kcal ที่เหลือ' : 'kcal ที่เกิน';
  $('#calText').innerHTML = `${fmt(s.kcal)} <span class="muted small">/ ${fmt(t.cal)} kcal</span>`;
  $('#calPct').textContent = `${p}% ของวันนี้`;
  $('#proText').innerHTML = `${fmt(s.protein)} <span class="muted small">/ ${fmt(t.pro)} g (${pct(s.protein, t.pro)}%)</span>`;
  $('#proBar').style.width = Math.min(100, pct(s.protein, t.pro)) + '%';
  $('#macroMini').textContent = s.n ? `คาร์บ ${fmt(s.carbs)} g · ไขมัน ${fmt(s.fat)} g` : '';

  let hint;
  if (!s.n) hint = 'ยังไม่ได้บันทึกมื้อไหนเลย ถ่ายรูปอาหารมื้อแรกกันเลย!';
  else if (left < 0) hint = `วันนี้เกินเป้าแล้ว ${fmt(-left)} kcal — มื้อต่อไปเน้นผักและโปรตีนไม่ติดมัน`;
  else {
    const proLeft = t.pro - s.protein;
    hint = proLeft > 0
      ? `ยังกินได้อีก ${fmt(left)} kcal และควรได้โปรตีนอีก ${fmt(proLeft)} g`
      : `โปรตีนครบแล้ว ยังกินได้อีก ${fmt(left)} kcal`;
  }
  $('#dayHint').textContent = hint;

  const meals = state.meals.filter(m => m.date === key).sort((a, b) => a.time.localeCompare(b.time));
  $('#mealList').innerHTML = meals.length
    ? meals.map(mealCard).join('')
    : `<div class="empty"><div class="e">${ic('utensils')}</div>ยังไม่มีมื้ออาหารวันนี้</div>`;
}

// ---------------- render: history ----------------
function renderHistory() {
  const t = targets();
  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push({ d, key: dateKey(d), s: totalsFor(dateKey(d)) });
  }
  const max = Math.max(t.cal * 1.2, ...days.map(x => x.s.kcal));
  const withData = days.filter(x => x.s.n);
  const avg = withData.length ? withData.reduce((a, x) => a + x.s.kcal, 0) / withData.length : 0;
  const avgP = withData.length ? withData.reduce((a, x) => a + x.s.protein, 0) / withData.length : 0;
  $('#weekChart').innerHTML = `
    <h3>7 วันล่าสุด</h3>
    <div class="plot">
      <div class="goal-line" style="bottom:${22 + (t.cal / max) * 110}px"></div>
      <div class="week-bars">
        ${days.map(x => `<div class="wb ${x.key === dateKey() ? 'today' : ''}">
          <div class="colbox"><div class="col ${x.s.n ? (x.s.kcal > t.cal ? 'over' : '') : 'zero'}" style="height:${Math.max(2, (x.s.kcal / max) * 100)}%"></div></div>
          <div class="d">${thaiDate(x.d, { weekday: 'narrow' })}</div></div>`).join('')}
      </div>
    </div>
    <div class="legend"><span>┅ เป้า ${fmt(t.cal)} kcal</span><span>เฉลี่ย ${fmt(avg)} kcal · โปรตีน ${fmt(avgP)} g/วัน</span></div>`;

  const byDate = {};
  state.meals.forEach(m => (byDate[m.date] = byDate[m.date] || []).push(m));
  const keys = Object.keys(byDate).sort().reverse();
  $('#historyList').innerHTML = keys.length ? keys.map(k => {
    const ms = byDate[k].sort((a, b) => a.time.localeCompare(b.time));
    const s = totalsFor(k);
    const tg = ms[0].target || t;
    const isToday = k === dateKey();
    return `<div class="card day-card">
      <button class="day-head" data-day="${k}">
        <div><div class="t">${isToday ? 'วันนี้ · ' : ''}${thaiDate(parseKey(k), { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' })}</div>
        <div class="s">${ms.length} มื้อ · ${fmt(s.kcal)} kcal · โปรตีน ${fmt(s.protein)} g</div></div>
        <span class="muted">▾</span>
      </button>
      <div class="day-bars">
        <div class="lbl-ic cal">${ic('flame')}${pct(s.kcal, tg.cal)}%<div class="bar" style="background:var(--orange-soft)"><div class="bar-fill ${s.kcal > tg.cal ? 'over' : 'cal'}" style="width:${Math.min(100, pct(s.kcal, tg.cal))}%"></div></div></div>
        <div class="lbl-ic pro">${ic('drumstick')}${pct(s.protein, tg.pro)}%<div class="bar"><div class="bar-fill protein" style="width:${Math.min(100, pct(s.protein, tg.pro))}%"></div></div></div>
      </div>
      <div class="day-meals" data-meals="${k}" hidden>${ms.map(mealCard).join('')}</div>
    </div>`;
  }).join('') : `<div class="empty"><div class="e">${ic('calendar')}</div>ยังไม่มีประวัติ</div>`;
}

// ---------------- render: profile ----------------
function stepperHtml(field, label, unit, min, max, step, value) {
  return `<div class="stepper" data-field="${field}" data-min="${min}" data-max="${max}" data-step="${step}">
    <label>${label}</label>
    <div class="stepper-ctl"><button type="button" class="st-btn" data-d="-1">−</button>
    <input type="number" inputmode="decimal" value="${value}"><button type="button" class="st-btn" data-d="1">+</button><span class="unit">${unit}</span></div></div>`;
}

function targetCards(t) {
  return `<div class="tcard cal"><div class="v">${fmt(t.cal)}</div><div class="l">kcal / วัน</div></div>
          <div class="tcard pro"><div class="v">${fmt(t.pro)} g</div><div class="l">โปรตีน / วัน</div></div>`;
}

function renderProfile() {
  const p = state.profile;
  const t = targets();
  $('#profileTargets').innerHTML = targetCards(t);
  const bmi = p.weight / ((p.height / 100) ** 2);
  const bmiLabel = bmi < 18.5 ? 'น้ำหนักน้อย' : bmi < 23 ? 'ปกติ' : bmi < 25 ? 'ท้วม' : bmi < 30 ? 'อ้วนระดับ 1' : 'อ้วนระดับ 2';
  $('#bmiText').textContent = `BMI ${bmi.toFixed(1)} (${bmiLabel}) · ร่างกายเผาผลาญขณะพัก (BMR) ${fmt(t.bmr)} kcal · ใช้พลังงานต่อวัน (TDEE) ${fmt(t.tdee)} kcal`;
  $('#profileSteppers').innerHTML =
    stepperHtml('age', 'อายุ', 'ปี', 10, 100, 1, p.age) +
    stepperHtml('weight', 'น้ำหนัก', 'กก.', 25, 250, 0.5, p.weight) +
    stepperHtml('height', 'ส่วนสูง', 'ซม.', 100, 230, 1, p.height);
  $$('#tab-profile .seg').forEach(seg => $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.value === String(p[seg.dataset.field]))));
  $('#pfActivity').value = String(p.activity);
  $('#pfCustomCal').value = p.customCal || '';
  $('#pfCustomPro').value = p.customPro || '';
  // Model list follows whichever provider is in use.
  const prov = activeProvider();
  $('#pfModel').innerHTML = PROVIDERS[prov].models
    .map((m, i) => `<option value="${m}">${m}${i === 0 ? ' (แนะนำ)' : ''}</option>`).join('');
  $('#pfModel').value = (state.settings.models || {})[prov] || PROVIDERS[prov].models[0];
  $('#aiStatus').innerHTML = state.settings.apiKey
    ? `<span class="status ok">${ic('check-circle')}<b>ใช้คีย์ ${PROVIDERS[prov].label} ของคุณเอง</b></span> ดูรูปอาหารได้`
    : PROXY_URL
      ? `<span class="status ok">${ic('check-circle')}<b>พร้อมใช้งาน</b></span> ถ่ายรูปอาหารได้เลย ไม่ต้องตั้งค่าอะไร`
      : `<span class="status">${ic('info')}<b>ยังไม่ได้เชื่อม AI</b></span> ตอนนี้เลือกเมนูจากรายการได้ ถ้าจะให้ดูรูปอาหาร ทำ 2 ขั้นตอนด้านล่าง`;
  // With the shared AI a personal key is optional, so keep it folded away unless one is set.
  $('#pfOwnKey').open = !PROXY_URL || !!state.settings.apiKey;
  $('#pfOwnKey summary').textContent = PROXY_URL ? 'ใช้คีย์ของตัวเองแทน (ไม่จำเป็น)' : 'เชื่อมต่อ AI';
  keyBox($('#pfKeyBox'), () => setTimeout(renderProfile, 1200));
  renderWeights();
}

function renderWeights() {
  const w = state.weights.slice(-30);
  const box = $('#weightChart');
  if (w.length < 2) { box.innerHTML = `<p class="small muted">น้ำหนักปัจจุบัน ${state.profile.weight} กก. — บันทึกน้ำหนักใหม่เมื่อมีการเปลี่ยนแปลงเพื่อดูกราฟ</p>`; return; }
  const vals = w.map(x => x.kg);
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const W = 300, H = 110;
  const pts = w.map((x, i) => [10 + (i / (w.length - 1)) * (W - 20), 10 + (1 - (x.kg - lo) / (hi - lo)) * (H - 30)]);
  const diff = vals[vals.length - 1] - vals[0];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round" points="${pts.map(p => p.join(',')).join(' ')}"/>
      ${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="var(--green)"/>`).join('')}
    </svg>
    <div class="weight-list"><span>เริ่ม ${vals[0]} กก.</span><span>ล่าสุด ${vals[vals.length - 1]} กก.</span><span><b>${diff > 0 ? '+' : ''}${diff.toFixed(1)} กก.</b></span></div>`;
}

function logWeight(kg) {
  const k = dateKey();
  const last = state.weights[state.weights.length - 1];
  if (last && last.date === k) last.kg = kg;
  else if (!last || last.kg !== kg) state.weights.push({ date: k, kg });
  LS.set('weights', state.weights);
}

function renderAll() {
  renderToday();
  if (!$('#tab-history').hidden) renderHistory();
  if (!$('#tab-profile').hidden) renderProfile();
}

function switchTab(name) {
  $$('.tab').forEach(t => (t.hidden = t.id !== 'tab-' + name));
  $$('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'history') renderHistory();
  if (name === 'profile') renderProfile();
  if (name === 'today') renderToday();
  window.scrollTo(0, 0);
}

// ---------------- stepper (shared) ----------------
document.addEventListener('click', e => {
  const b = e.target.closest('.st-btn');
  if (!b) return;
  const st = b.closest('.stepper');
  const inp = $('input', st);
  const step = Number(st.dataset.step);
  let v = (Number(inp.value) || 0) + step * Number(b.dataset.d);
  v = Math.min(Number(st.dataset.max), Math.max(Number(st.dataset.min), v));
  inp.value = Math.round(v * 10) / 10;
});
function readSteppers(root) {
  const o = {};
  $$('.stepper', root).forEach(st => {
    const v = Number($('input', st).value);
    o[st.dataset.field] = Math.min(Number(st.dataset.max), Math.max(Number(st.dataset.min), v || Number(st.dataset.min)));
  });
  return o;
}

// ---------------- onboarding ----------------
function startOnboarding() {
  const ob = $('#onboarding');
  ob.hidden = false; $('#main').hidden = true;
  const draft = { sex: null, activity: null, goal: null };
  const steps = $$('.ob-step', ob);
  let cur = 0;
  $('#obDots').innerHTML = steps.map(() => '<i></i>').join('');
  const show = (i, dir = 1) => {
    if (i === 4 && PROXY_URL) return show(i + dir, dir);
    cur = i;
    steps.forEach((s, j) => s.classList.toggle('active', j === i));
    $$('#obDots i').forEach((d, j) => d.classList.toggle('on', j === i));
    $('#obBack').hidden = i === 0;
    if (i === 4) keyBox($('#obKeyBox'), () => { $('#obKeyNext').hidden = false; setTimeout(() => show(5), 900); });
    if (i === 5) {
      Object.assign(draft, readSteppers(steps[1]));
      $('#obTargets').innerHTML = targetCards(calcTargets(draft));
    }
    window.scrollTo(0, 0);
  };
  ob.addEventListener('click', e => {
    const c = e.target.closest('.choice');
    if (c) {
      $$(`.choice[data-field="${c.dataset.field}"]`, ob).forEach(x => x.classList.toggle('selected', x === c));
      draft[c.dataset.field] = c.dataset.field === 'activity' ? Number(c.dataset.value) : c.dataset.value;
      setTimeout(() => show(cur + 1), 180);
      return;
    }
    if (e.target.closest('.ob-next')) {
      show(cur + 1);
    }
    if (e.target.closest('.ob-skip')) show(cur + 1);
  });
  $('#obBack').onclick = () => show(Math.max(0, cur - 1), -1);
  $('#obFinish').onclick = () => {
    state.profile = { ...draft, ...readSteppers(steps[1]), customCal: 0, customPro: 0 };
    LS.set('profile', state.profile);
    LS.set('settings', state.settings);
    logWeight(state.profile.weight);
    ob.hidden = true;
    startMain();
  };
  show(0);
}

// ---------------- main wiring ----------------
let mainWired = false;
function startMain() {
  $('#main').hidden = false;
  switchTab('today');
  if (mainWired) return;
  mainWired = true;

  $('.bottom-nav').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); };
  $('#btnCamera').onclick = () => $('#fileCamera').click();
  $('#btnGallery').onclick = () => $('#fileGallery').click();
  $('#btnText').onclick = () => showFoodSearch();
  ['#fileCamera', '#fileGallery'].forEach(id => $(id).addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = ''; handleFile(f);
  }));
  $('#sheetBackdrop').onclick = closeSheet;

  document.addEventListener('click', e => {
    const m = e.target.closest('[data-meal]');
    if (m) return openMeal(m.dataset.meal);
    const d = e.target.closest('[data-day]');
    if (d) { const list = $(`[data-meals="${d.dataset.day}"]`); list.hidden = !list.hidden; }
  });

  // profile
  $$('#tab-profile .seg').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#pfSave').onclick = () => {
    const segVal = f => $(`#tab-profile .seg[data-field="${f}"] button.on`)?.dataset.value;
    const prev = state.profile.weight;
    state.profile = {
      ...state.profile,
      ...readSteppers($('#profileSteppers')),
      sex: segVal('sex'), goal: segVal('goal'),
      activity: Number($('#pfActivity').value),
      customCal: Number($('#pfCustomCal').value) || 0,
      customPro: Number($('#pfCustomPro').value) || 0,
    };
    LS.set('profile', state.profile);
    if (state.profile.weight !== prev) logWeight(state.profile.weight);
    renderProfile(); renderToday();
    toast('บันทึกแล้ว เป้าหมายใหม่ ' + fmt(targets().cal) + ' kcal');
  };
  $('#pfModel').onchange = () => {
    state.settings.models = { ...(state.settings.models || {}), [activeProvider()]: $('#pfModel').value };
    LS.set('settings', state.settings);
    toast('เปลี่ยนโมเดลแล้ว');
  };
  $('#pfRemoveKey').onclick = () => {
    if (!state.settings.apiKey || !confirm('ลบคีย์ของคุณออกจากเครื่องนี้?')) return;
    state.settings.apiKey = ''; state.settings.provider = '';
    LS.set('settings', state.settings);
    renderProfile(); toast('ลบคีย์แล้ว');
  };
  $('#pfExport').onclick = () => {
    const data = { app: 'NubCal', version: 1, exported: new Date().toISOString(), profile: state.profile, weights: state.weights, meals: state.meals };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `nubcal-backup-${dateKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#pfImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!['NubCal', 'CalCha'].includes(d.app) || !Array.isArray(d.meals)) throw 0;
      if (!confirm(`นำเข้า ${d.meals.length} มื้อ? (ข้อมูลเดิมที่ id ซ้ำจะถูกแทนที่)`)) return;
      for (const m of d.meals) await DB.put(m);
      if (d.profile) { state.profile = d.profile; LS.set('profile', d.profile); }
      if (Array.isArray(d.weights)) { state.weights = d.weights; LS.set('weights', d.weights); }
      state.meals = await DB.all();
      renderAll(); renderProfile(); toast('นำเข้าข้อมูลแล้ว');
    } catch { toast('ไฟล์ไม่ถูกต้อง'); }
  };
  $('#pfReset').onclick = async () => {
    if (!confirm('ลบข้อมูลทั้งหมด (โปรไฟล์ มื้ออาหาร น้ำหนัก)?')) return;
    if (!confirm('แน่ใจนะ? กู้คืนไม่ได้')) return;
    await DB.clear();
    ['profile', 'weights', 'settings'].forEach(LS.del);
    location.reload();
  };

  // re-render when the day changes / app comes back to foreground
  let lastDay = dateKey();
  const check = () => { if (dateKey() !== lastDay) { lastDay = dateKey(); renderAll(); } };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); renderToday(); } });
  setInterval(check, 60000);
}

// ---------------- boot ----------------
(async function boot() {
  hydrateIcons();
  try { state.meals = await DB.all(); } catch { state.meals = []; }
  if (state.profile) startMain(); else startOnboarding();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
