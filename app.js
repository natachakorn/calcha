/* CalCha (แคลแชะ) — snap food, get calories & protein.
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

const state = {
  profile: LS.get('profile', null),
  settings: LS.get('settings', { apiKey: '', model: 'gemini-flash-latest' }),
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

const MEAL_TYPES = { breakfast: '🌅 เช้า', lunch: '☀️ กลางวัน', dinner: '🌙 เย็น', snack: '🍪 ของว่าง' };
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

// ---------------- Gemini ----------------
const GEMINI_URL = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

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
  const t = targets();
  const eaten = totalsFor(dateKey());
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
- ข้อมูลผู้ใช้: เป้าหมายวันนี้ ${t.cal} kcal, โปรตีน ${t.pro} g, กินไปแล้ว ${Math.round(eaten.kcal)} kcal, โปรตีน ${Math.round(eaten.protein)} g
  ใช้ข้อมูลนี้ให้ tip ที่เป็นประโยชน์ (เช่น ควรเพิ่มโปรตีน หรือมื้อนี้ค่อนข้างหนัก)`;
}

class AIError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

async function callGemini(parts) {
  const key = state.settings.apiKey;
  if (!key) throw new AIError('ยังไม่ได้ใส่ API Key', 'nokey');
  const models = [...new Set([state.settings.model, ...FALLBACK_MODELS])];
  let lastErr;
  for (const model of models) {
    let r;
    try {
      r = await fetch(GEMINI_URL(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
        }),
      });
    } catch {
      throw new AIError('เชื่อมต่ออินเทอร์เน็ตไม่ได้ ลองใหม่อีกครั้ง', 'network');
    }
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      const txt = (body.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (!txt) throw new AIError('AI ไม่ตอบกลับ (อาจถูกบล็อกเนื้อหา) ลองรูปอื่น', 'empty');
      try { return JSON.parse(txt); } catch { throw new AIError('อ่านผลจาก AI ไม่ได้ ลองใหม่อีกครั้ง', 'parse'); }
    }
    const msg = body.error?.message || r.statusText;
    if (r.status === 404 || (r.status === 400 && /model/i.test(msg) && !/key/i.test(msg))) { lastErr = new AIError(msg, 'model'); continue; }
    if (r.status === 400 && /api key/i.test(msg) || r.status === 403) throw new AIError('API Key ไม่ถูกต้อง กรุณาตรวจสอบในหน้า "ข้อมูลฉัน"', 'badkey');
    if (r.status === 429) throw new AIError('ใช้ AI ฟรีครบโควต้าแล้วชั่วคราว รอสักครู่แล้วลองใหม่ หรือเปลี่ยนโมเดลเป็น flash-lite', 'quota');
    if (r.status === 503 || r.status === 500) { lastErr = new AIError('เซิร์ฟเวอร์ AI ไม่ว่าง ลองใหม่อีกครั้ง', 'busy'); continue; }
    throw new AIError(msg, 'other');
  }
  throw lastErr || new AIError('ไม่พบโมเดลที่ใช้งานได้', 'model');
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
    <h2>🤔 รูปนี้เคยส่งแล้ว</h2>
    <p class="muted small">ส่งไปเมื่อ <b>${when}</b> — ${esc(dup.name)} (${fmt(dup.kcal)} kcal)</p>
    <div class="dup-imgs">
      <figure><img src="${dup.thumb}" alt=""><figcaption>ที่บันทึกไว้</figcaption></figure>
      <figure><img src="${p.thumb}" alt=""><figcaption>รูปที่ส่งตอนนี้</figcaption></figure>
    </div>
    <p><b>เป็นมื้อเดิม หรือมื้อใหม่?</b></p>
    <button class="btn ghost block" data-a="same">🔁 มื้อเดิม — ไม่ต้องนับซ้ำ</button>
    <button class="btn primary block" data-a="new">➕ มื้อใหม่ — กินอีกครั้ง นับเพิ่ม</button>
    <button class="btn plain block" data-a="reanalyze">🔍 เป็นอาหารอื่น ให้ AI วิเคราะห์ใหม่</button>
  `);
  sh.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    sh.onclick = null;
    if (a === 'same') { closeSheet(); toast('โอเค ไม่นับซ้ำ ✅'); }
    else if (a === 'new') {
      const base = dup.base || { name: dup.name, items: dup.items, kcal: dup.kcal, protein: dup.protein, carbs: dup.carbs, fat: dup.fat, confidence: dup.confidence, tip: '' };
      showResult({ analysis: { ...base, is_food: true }, thumb: p.thumb, sig: p.sig, sha: p.sha, source: dup.source || 'photo', portion: dup.portion || 1 });
    } else analyzePhoto(p);
  };
}

async function analyzePhoto(p) {
  if (!state.settings.apiKey) return showNoKey(p);
  openSheet(`<div class="loading"><img src="${p.thumb}" alt=""><div class="spinner"></div><b>AI กำลังดูจานของคุณ…</b><p class="small muted">ประมาณ 3–10 วินาที</p></div>`);
  try {
    const raw = await callGemini([
      { inline_data: { mime_type: 'image/jpeg', data: p.ai.split(',')[1] } },
      { text: buildPrompt('photo') },
    ]);
    const a = normalize(raw);
    if (!a.is_food) return showError('ดูเหมือนในรูปจะไม่ใช่อาหาร 🧐 ลองถ่ายใหม่ให้เห็นจานชัดๆ', p);
    showResult({ analysis: a, thumb: p.thumb, sig: p.sig, sha: p.sha, source: 'photo', portion: 1 });
  } catch (err) {
    showError(err.message, p, err.code);
  }
}

function showTextInput() {
  const sh = openSheet(`
    <h2>✏️ พิมพ์เมนูที่กิน</h2>
    <p class="muted small">บอกชื่อและปริมาณคร่าวๆ เช่น "ข้าวมันไก่ 1 จาน + น้ำซุป" หรือ "กาแฟเย็น 1 แก้ว หวานน้อย"</p>
    <textarea id="foodText" class="text-input" placeholder="กินอะไรมา…"></textarea>
    <button class="btn primary block" id="goText">🔍 คำนวณ</button>
    <button class="btn plain block" id="goManual">ใส่ตัวเลขเอง</button>
  `);
  setTimeout(() => $('#foodText')?.focus(), 250);
  $('#goManual', sh).onclick = () => showResult({ analysis: { name: '', items: [], kcal: 0, protein: 0, carbs: 0, fat: 0, confidence: 'high', tip: '' }, source: 'manual', portion: 1, editing: true });
  $('#goText', sh).onclick = async () => {
    const text = $('#foodText').value.trim();
    if (!text) return toast('พิมพ์ชื่ออาหารก่อนนะ');
    if (!state.settings.apiKey) return showNoKey();
    openSheet(`<div class="loading"><div class="spinner"></div><b>กำลังคำนวณ "${esc(text)}"…</b></div>`);
    try {
      const a = normalize(await callGemini([{ text: buildPrompt('text', text) }]));
      if (!a.is_food) return showError('ไม่แน่ใจว่าเป็นอาหารอะไร ลองพิมพ์ให้ละเอียดขึ้น');
      showResult({ analysis: a, source: 'text', portion: 1 });
    } catch (err) { showError(err.message, null, err.code); }
  };
}

function showNoKey(p) {
  const sh = openSheet(`
    <h2>🔑 ยังไม่ได้เชื่อมต่อ AI</h2>
    <p class="muted">ต้องใส่ Google Gemini API Key (ฟรี) ก่อน จึงจะให้ AI ดูรูปอาหารได้</p>
    <button class="btn primary block" data-a="key">ไปใส่ API Key</button>
    <button class="btn plain block" data-a="manual">ใส่แคล/โปรตีนเอง</button>
  `);
  sh.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'key') { closeSheet(); switchTab('profile'); setTimeout(() => $('#pfKey').focus(), 300); }
    if (a === 'manual') showResult({ analysis: { name: '', items: [], kcal: 0, protein: 0, carbs: 0, fat: 0, confidence: 'high', tip: '' }, thumb: p?.thumb, sig: p?.sig, sha: p?.sha, source: 'manual', portion: 1, editing: true });
  };
}

function showError(msg, p, code) {
  const sh = openSheet(`
    <h2>😅 ขออภัย</h2>
    <p>${esc(msg)}</p>
    ${p ? '<button class="btn primary block" data-a="retry">ลองใหม่</button>' : ''}
    ${code === 'badkey' ? '<button class="btn ghost block" data-a="key">แก้ไข API Key</button>' : ''}
    <button class="btn plain block" data-a="manual">ใส่ตัวเลขเอง</button>
    <button class="btn plain block" data-a="close">ปิด</button>
  `);
  sh.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'retry') analyzePhoto(p);
    if (a === 'key') { closeSheet(); switchTab('profile'); }
    if (a === 'manual') showResult({ analysis: { name: '', items: [], kcal: 0, protein: 0, carbs: 0, fat: 0, confidence: 'high', tip: '' }, thumb: p?.thumb, sig: p?.sig, sha: p?.sha, source: 'manual', portion: 1, editing: true });
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
      <div class="imp-sub">${over ? `⚠️ รวมแล้วเกินเป้า ${fmt(-left)} ${unit}` : `รวมทั้งวัน ${pct(total, target)}% · เหลืออีก ${fmt(left)} ${unit}`}</div>
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
    ${ctx.source !== 'manual' ? `<span class="conf">🤖 ${CONF[a.confidence] || ''}</span>` : ''}
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
      <h4>${ctx.existing ? '📊 มื้อนี้ในวันนั้น' : `📊 ถ้ากินมื้อนี้ ${isToday ? 'วันนี้' : ''}จะเป็น…`}</h4>
      ${impactRow('🔥 แคล', 'kcal', before.kcal, cur.kcal, t.cal, 'cal')}
      ${impactRow('🥩 โปรตีน', 'g', before.protein, cur.protein, t.pro, 'pro')}
    </div>
    ${a.tip ? `<div class="tip">💡 ${esc(a.tip)}</div>` : ''}
    ${itemsHtml ? `<details ${a.items.length <= 4 ? 'open' : ''}><summary class="small muted">รายละเอียดในจาน</summary>${itemsHtml}</details>` : ''}
    <p class="small muted" style="margin:14px 0 6px">มื้อ</p>
    <div class="mealtype">${Object.entries(MEAL_TYPES).map(([v, l]) => `<button data-type="${v}" class="${v === ctx.type ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${!ctx.editing ? '<button class="btn plain block" id="rsEdit">✏️ แก้ไขตัวเลข</button>' : ''}
    <button class="btn primary block" id="rsSave">${ctx.existing ? '💾 บันทึกการแก้ไข' : '✅ บันทึกว่ากินมื้อนี้'}</button>
    ${ctx.existing ? '<button class="btn danger block" id="rsDel">🗑️ ลบมื้อนี้</button>' : ''}
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
    toast(ctx.existing ? 'บันทึกการแก้ไขแล้ว' : `บันทึกแล้ว +${fmt(meal.kcal)} kcal, +${fmt(meal.protein)} g โปรตีน 🎉`);
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
    ${m.thumb ? `<img src="${m.thumb}" alt="">` : `<div class="noimg">🍽️</div>`}
    <div class="info"><div class="name">${esc(m.name)}</div><div class="meta">${MEAL_TYPES[m.type] || ''} · ${timeStr(m.time)}${m.portion && m.portion !== 1 ? ` · ×${m.portion}` : ''}</div></div>
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
  $('#greet').textContent = h < 11 ? 'อรุณสวัสดิ์ ☀️' : h < 17 ? 'สวัสดีตอนบ่าย 🌤️' : 'สวัสดีตอนเย็น 🌙';

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
  if (!s.n) hint = '📸 ยังไม่ได้บันทึกมื้อไหนเลย แชะรูปอาหารมื้อแรกกันเลย!';
  else if (left < 0) hint = `⚠️ วันนี้เกินเป้าแล้ว ${fmt(-left)} kcal — มื้อต่อไปเน้นผักและโปรตีนไม่ติดมัน`;
  else {
    const proLeft = t.pro - s.protein;
    hint = proLeft > 0
      ? `ยังกินได้อีก ${fmt(left)} kcal และควรได้โปรตีนอีก ${fmt(proLeft)} g 💪`
      : `โปรตีนครบแล้ว 👏 ยังกินได้อีก ${fmt(left)} kcal`;
  }
  $('#dayHint').textContent = hint;

  const meals = state.meals.filter(m => m.date === key).sort((a, b) => a.time.localeCompare(b.time));
  $('#mealList').innerHTML = meals.length
    ? meals.map(mealCard).join('')
    : `<div class="empty"><div class="e">🍽️</div>ยังไม่มีมื้ออาหารวันนี้</div>`;
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
        <div>🔥 ${pct(s.kcal, tg.cal)}%<div class="bar" style="background:var(--orange-soft)"><div class="bar-fill ${s.kcal > tg.cal ? 'over' : 'cal'}" style="width:${Math.min(100, pct(s.kcal, tg.cal))}%"></div></div></div>
        <div>🥩 ${pct(s.protein, tg.pro)}%<div class="bar"><div class="bar-fill protein" style="width:${Math.min(100, pct(s.protein, tg.pro))}%"></div></div></div>
      </div>
      <div class="day-meals" data-meals="${k}" hidden>${ms.map(mealCard).join('')}</div>
    </div>`;
  }).join('') : `<div class="empty"><div class="e">📅</div>ยังไม่มีประวัติ</div>`;
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
  $('#pfKey').value = state.settings.apiKey || '';
  $('#pfModel').value = state.settings.model;
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
  const show = i => {
    cur = i;
    steps.forEach((s, j) => s.classList.toggle('active', j === i));
    $$('#obDots i').forEach((d, j) => d.classList.toggle('on', j === i));
    $('#obBack').hidden = i === 0;
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
      if (cur === 4) state.settings.apiKey = $('#obKey').value.trim();
      show(cur + 1);
    }
    if (e.target.closest('.ob-skip')) show(cur + 1);
  });
  $('#obBack').onclick = () => show(Math.max(0, cur - 1));
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
  $('#btnText').onclick = showTextInput;
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
    toast('บันทึกแล้ว เป้าหมายใหม่ ' + fmt(targets().cal) + ' kcal ✅');
  };
  $('#pfSaveKey').onclick = () => {
    state.settings.apiKey = $('#pfKey').value.trim();
    state.settings.model = $('#pfModel').value;
    LS.set('settings', state.settings);
    toast('บันทึกการตั้งค่า AI แล้ว');
  };
  $('#pfTestKey').onclick = async () => {
    const old = { ...state.settings };
    state.settings.apiKey = $('#pfKey').value.trim();
    state.settings.model = $('#pfModel').value;
    toast('กำลังทดสอบ…', 8000);
    try {
      const a = normalize(await callGemini([{ text: buildPrompt('text', 'ไข่ต้ม 1 ฟอง') }]));
      toast(`✅ เชื่อมต่อสำเร็จ (ไข่ต้ม ≈ ${a.kcal} kcal)`);
      LS.set('settings', state.settings);
    } catch (err) {
      state.settings = old;
      toast('❌ ' + err.message, 5000);
    }
  };
  $('#pfExport').onclick = () => {
    const data = { app: 'CalCha', version: 1, exported: new Date().toISOString(), profile: state.profile, weights: state.weights, meals: state.meals };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `calcha-backup-${dateKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#pfImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'CalCha' || !Array.isArray(d.meals)) throw 0;
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
  try { state.meals = await DB.all(); } catch { state.meals = []; }
  if (state.profile) startMain(); else startOnboarding();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
