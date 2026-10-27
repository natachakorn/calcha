var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var MAX_BODY = 4 * 1024 * 1024;
var worker_default = {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin"
    };
    const json = /* @__PURE__ */ __name((status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } }), "json");
    const fail = /* @__PURE__ */ __name((status, message) => json(status, { error: { code: status, message } }), "fail");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return fail(405, "POST only");
    if (!okOrigin) return fail(403, "origin not allowed");
    if (!env.GEMINI_API_KEY) return fail(500, "server key not configured");
    if (env.RATE_LIMITER) {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return fail(429, "too many requests from this device, slow down");
    }
    const len = Number(req.headers.get("Content-Length") || 0);
    if (len > MAX_BODY) return fail(413, "request too large");
    let body;
    try {
      body = await req.json();
    } catch {
      return fail(400, "invalid JSON");
    }
    const { model, request } = body || {};
    if (typeof model !== "string" || !/^gemini-[\w.-]+$/.test(model)) return fail(400, "invalid model");
    if (!request || !Array.isArray(request.contents)) return fail(400, "invalid request");
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: request.contents, generationConfig: request.generationConfig })
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json" }
    });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
