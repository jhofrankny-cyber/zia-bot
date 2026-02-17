const express = require("express");
const Redis = require("ioredis");
const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ENV
const PORT = process.env.PORT || 3000;
const MC_AUTH_TOKEN = process.env.MC_AUTH_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const REDIS_URL_RAW = process.env.REDIS_URL || "";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

// ✅ ManyChat Admin Notify (Opción A)
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY || "";
const ADMIN_SUBSCRIBER_ID = process.env.ADMIN_SUBSCRIBER_ID || "";
const MANYCHAT_API_BASE = process.env.MANYCHAT_API_BASE || "https://api.manychat.com";

// ✅ (Opcional) Fallback a Meta WhatsApp Cloud API
const WA_TOKEN = process.env.WA_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "";

// =============================
// ✅ TICK / FOLLOW-UPS (NUEVO)
// - Cada 4 horas por 24h (máx 6)
// - Solo si fue el primer mensaje (inbound_count === 1)
// - Si escribe 2do mensaje o ya cerró (cierre_enviado) => cancelar
// - Se guarda en Redis (ZSET + mem) y se procesa con /tick
// =============================
const TICK_TOKEN = process.env.TICK_TOKEN || "";

const FOLLOWUP_ZSET_KEY = "zia:followup:due";
const FOLLOWUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const FOLLOWUP_MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const FOLLOWUP_MAX_COUNT = 6;
const FOLLOWUP_BATCH_LIMIT = 25;

// --- Helpers ---
function safeText(x) {
  return String(x ?? "").trim();
}

function mustAuth(req) {
  // Si no configuras token, no exige auth (modo dev)
  if (!MC_AUTH_TOKEN) return true;
  return req.headers.authorization === `Bearer ${MC_AUTH_TOKEN}`;
}

function normalizeRedisUrl(url) {
  const u = safeText(url);
  if (!u) return "";
  if (u.startsWith("redis://")) return "rediss://" + u.slice("redis://".length);
  return u;
}

function clampHistory(history, max = 10) {
  if (!Array.isArray(history)) return [];
  return history.slice(-max);
}

// ✅ detectar @ / links / nombres raros sin “rechazarlos”
function looksLikeLinkOrHandle(t) {
  const s = safeText(t);
  const low = s.toLowerCase();
  return (
    s.includes("@") ||
    low.includes("http") ||
    low.includes("www.") ||
    low.includes(".com") ||
    low.includes(".do") ||
    low.includes("instagram") ||
    low.includes("tiktok") ||
    low.includes("wa.me")
  );
}

function looksLikeBusinessName(t) {
  const s = safeText(t);
  if (s.length < 3) return false;

  const low = s.toLowerCase();

  const blocked = new Set([
    "hola",
    "buenas",
    "buenos dias",
    "buenas tardes",
    "buenas noches",
    "ok",
    "okay",
    "gracias",
    "mañana",
    "perfecto",
    "listo",
    "si",
    "sí",
    "no",
    "ambos",
    "ambas",
    "redes",
    "bot",
    "ventas",
    "leads",
    "reservas",
    "posicionamiento",
    "👍",
    "...",
    "..",
    ".",
  ]);

  if (blocked.has(low)) return false;
  return true;
}

// ✅ detectar si user_text es link de audio
function looksLikeAudioUrl(t) {
  const s = safeText(t).toLowerCase();
  if (!s) return false;
  if (!s.startsWith("http")) return false;
  const audioExt = [".ogg", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".aac"];
  return audioExt.some((ext) => s.includes(ext));
}

// ✅ helpers para buscar URLs dentro de objetos/string JSON
function tryParseJson(x) {
  if (!x) return null;
  if (typeof x === "object") return x;
  const s = safeText(x);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function findFirstUrlDeep(input) {
  const seen = new Set();

  function walk(x) {
    if (x == null) return "";
    if (typeof x === "string") {
      const s = x.trim();
      const m = s.match(/https?:\/\/[^\s"']+/i);
      return m ? m[0] : "";
    }
    if (typeof x !== "object") return "";

    if (seen.has(x)) return "";
    seen.add(x);

    if (Array.isArray(x)) {
      for (const item of x) {
        const u = walk(item);
        if (u) return u;
      }
      return "";
    }

    for (const k of Object.keys(x)) {
      const u = walk(x[k]);
      if (u) return u;
    }
    return "";
  }

  return walk(input);
}

// ✅ extraer URL de audio si viene en otros campos
function getAudioUrl(body) {
  if (!body || typeof body !== "object") return "";

  const direct =
    body.voice_url ||
    body.audio_url ||
    body.media_url ||
    body.attachment_url ||
    body.file_url ||
    body.voice ||
    body.audio ||
    "";

  if (direct) {
    const parsed = tryParseJson(direct);
    if (parsed) {
      const u = findFirstUrlDeep(parsed);
      if (u) return safeText(u);
    }
    const u2 = findFirstUrlDeep(String(direct));
    if (u2) return safeText(u2);
  }

  const a1 = body.attachments?.[0]?.url || body.attachments?.[0]?.payload?.url;
  if (a1) return safeText(a1);

  const a2 =
    body.message?.attachments?.[0]?.url ||
    body.message?.attachments?.[0]?.payload?.url;
  if (a2) return safeText(a2);

  const fcd = body.full_contact_data;
  if (fcd) {
    const parsed = tryParseJson(fcd) || fcd;
    const u = findFirstUrlDeep(parsed);
    if (u) return safeText(u);
  }

  return "";
}

function extFromContentType(ct) {
  const c = safeText(ct).toLowerCase();
  if (c.includes("audio/ogg")) return "ogg";
  if (c.includes("audio/opus")) return "ogg";
  if (c.includes("audio/mpeg")) return "mp3";
  if (c.includes("audio/mp3")) return "mp3";
  if (c.includes("audio/mp4")) return "m4a";
  if (c.includes("audio/x-m4a")) return "m4a";
  if (c.includes("audio/wav")) return "wav";
  if (c.includes("audio/webm")) return "webm";
  return "ogg";
}

// ✅ transcribir audio desde URL
async function transcribeAudioFromUrl(url, openaiClient) {
  const u = safeText(url);
  if (!u) return "";

  try {
    const resp = await axios.get(u, {
      responseType: "arraybuffer",
      maxRedirects: 5,
      timeout: 20000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const ct = resp.headers?.["content-type"] || "";
    const ext = extFromContentType(ct);

    const tmpPath = path.join(os.tmpdir(), `zia-voice-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(resp.data));

    try {
      const transcription = await openaiClient.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: TRANSCRIBE_MODEL,
        language: "es",
      });

      return safeText(transcription?.text);
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  } catch (err) {
    console.error("[transcribe] ERROR:", err?.response?.status, err?.message || err);
    return "";
  }
}

// ✅ parser robusto para JSON del modelo
function extractFirstJsonObject(raw) {
  const s = safeText(raw);
  if (!s) return "";
  const noFences = s.replace(/```json|```/gi, "").trim();
  const first = noFences.indexOf("{");
  const last = noFences.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return "";
  return noFences.slice(first, last + 1);
}

function safeParseModelJson(raw) {
  const s = safeText(raw);
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch {}

  const candidate = extractFirstJsonObject(s);
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

// ✅ NUEVO: ManyChat notify helpers
function canNotifyAdminViaManyChat() {
  return !!(MANYCHAT_API_KEY && ADMIN_SUBSCRIBER_ID);
}

function canNotifyAdminViaMeta() {
  return !!(WA_TOKEN && PHONE_NUMBER_ID && ADMIN_PHONE);
}

function toDigits(x) {
  return safeText(x).replace(/[^\d]/g, "");
}

// ✅ (ACTUALIZADO TEXTO) - ahora resume según nueva lógica (sin cambiar campos)
function buildLeadSummary({ contactId, sector, servicio, redes }) {
  const waDigits = toDigits(contactId);
  const waLink = waDigits ? `https://wa.me/${waDigits}` : "";

  return (
    `🆕 Nuevo lead (Zia Bot)\n` +
    `🧩 Necesita: ${safeText(sector) || "-"}\n` +
    `📌 Detalle: ${safeText(servicio) || "-"}\n` +
    `📲 Negocio/IG: ${safeText(redes) || "-"}\n` +
    `👤 WhatsApp: ${waDigits || safeText(contactId) || "-"}\n` +
    (waLink ? `🔗 ${waLink}\n` : "") +
    `🕒 ${new Date().toLocaleString()}`
  );
}

function normalizeBaseUrl(base) {
  const b = safeText(base);
  if (!b) return "";
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

async function postManyChat(pathname, payload) {
  const base = normalizeBaseUrl(MANYCHAT_API_BASE);
  const url = `${base}${pathname}`;

  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${MANYCHAT_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 20000,
    validateStatus: () => true, // manejamos nosotros
  });
}

// ✅ NUEVO: intenta varios endpoints/payloads (porque ManyChat a veces cambia rutas por canal)
async function sendAdminViaManyChat(text) {
  const sid = Number(ADMIN_SUBSCRIBER_ID);
  const msg = safeText(text);

  const tries = [
    { path: "/whatsapp/sending/sendText", payload: { subscriber_id: sid, message: msg } },
    { path: "/whatsapp/sending/sendContent", payload: { subscriber_id: sid, message: msg } },

    { path: "/wa/sending/sendText", payload: { subscriber_id: sid, message: msg } },
    { path: "/wa/sending/sendContent", payload: { subscriber_id: sid, message: msg } },

    { path: "/fb/sending/sendContent", payload: { subscriber_id: sid, message: msg } },
    { path: "/fb/sending/sendText", payload: { subscriber_id: sid, message: msg } },

    { path: "/sending/sendContent", payload: { subscriber_id: sid, message: msg } },
    { path: "/sending/sendText", payload: { subscriber_id: sid, message: msg } },
  ];

  let lastErr = null;

  for (const t of tries) {
    try {
      console.log(`[admin_notify] try ${t.path}`);
      const resp = await postManyChat(t.path, t.payload);

      if (resp.status >= 200 && resp.status < 300) {
        console.log("[admin_notify] sent via ManyChat ✅", t.path);
        return true;
      }

      console.log(
        `[admin_notify] ${t.path} -> ${resp.status}`,
        typeof resp.data === "string" ? resp.data.slice(0, 120) : resp.data
      );

      lastErr = new Error(`ManyChat ${t.path} -> ${resp.status}`);
    } catch (e) {
      lastErr = e;
      console.log("[admin_notify] fail", t.path, e?.response?.status || "", e?.message || e);
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("ManyChat notify failed");
}

// ✅ NUEVO: enviar follow-up al usuario (ManyChat) usando contactId como subscriber_id
function canSendUserFollowupViaManyChat() {
  return !!MANYCHAT_API_KEY;
}

async function sendUserFollowupViaManyChat(contactId, text) {
  const sid = Number(toDigits(contactId) || contactId);
  const msg = safeText(text);
  if (!sid || !msg) return false;

  const tries = [
    { path: "/whatsapp/sending/sendText", payload: { subscriber_id: sid, message: msg } },
    { path: "/whatsapp/sending/sendContent", payload: { subscriber_id: sid, message: msg } },

    { path: "/wa/sending/sendText", payload: { subscriber_id: sid, message: msg } },
    { path: "/wa/sending/sendContent", payload: { subscriber_id: sid, message: msg } },

    { path: "/fb/sending/sendContent", payload: { subscriber_id: sid, message: msg } },
    { path: "/fb/sending/sendText", payload: { subscriber_id: sid, message: msg } },

    { path: "/sending/sendContent", payload: { subscriber_id: sid, message: msg } },
    { path: "/sending/sendText", payload: { subscriber_id: sid, message: msg } },
  ];

  let lastErr = null;

  for (const t of tries) {
    try {
      console.log(`[followup_user] try ${t.path} -> subscriber_id=${sid}`);
      const resp = await postManyChat(t.path, t.payload);

      if (resp.status >= 200 && resp.status < 300) {
        console.log("[followup_user] sent ✅", t.path);
        return true;
      }

      console.log(
        `[followup_user] ${t.path} -> ${resp.status}`,
        typeof resp.data === "string" ? resp.data.slice(0, 120) : resp.data
      );

      lastErr = new Error(`ManyChat ${t.path} -> ${resp.status}`);
    } catch (e) {
      lastErr = e;
      console.log("[followup_user] fail", t.path, e?.response?.status || "", e?.message || e);
    }
  }

  if (lastErr) throw lastErr;
  throw new Error("ManyChat followup failed");
}

// ✅ (Opcional) fallback Meta Cloud API
async function sendAdminViaMeta(text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const body = safeText(text);

  const resp = await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: toDigits(ADMIN_PHONE),
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (resp.status >= 200 && resp.status < 300) return true;

  console.log("[admin_notify][meta] ->", resp.status, resp.data);
  throw new Error(`Meta send failed: ${resp.status}`);
}

// --- Memory ---
function defaultMemory() {
  return {
    sector: "",
    servicio: "",
    redes: "",
    objetivo: "",
    cerrado: false,
    cierre_enviado: false,
    pending: "sector",
    history: [],
    admin_notified: false,
    inbound_count: 0,
    followup: {
      active: false,
      started_ts: 0,
      last_sent_ts: 0,
      next_due_ts: 0,
      count: 0,
      cancelled: false,
      cancel_reason: "",
      cancelled_ts: 0,
    },
  };
}

// --- Redis ---
const redisUrl = normalizeRedisUrl(REDIS_URL_RAW);
const redis = redisUrl
  ? new Redis(redisUrl, {
      tls: redisUrl.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    })
  : null;

async function loadMemory(contactId) {
  if (!redis) return defaultMemory();
  const key = `zia:${contactId}`;
  const raw = await redis.get(key);
  const mem = raw ? JSON.parse(raw) : defaultMemory();
  if (typeof mem.admin_notified !== "boolean") mem.admin_notified = false;

  if (typeof mem.inbound_count !== "number") mem.inbound_count = 0;
  if (!mem.followup || typeof mem.followup !== "object") {
    mem.followup = defaultMemory().followup;
  } else {
    if (typeof mem.followup.active !== "boolean") mem.followup.active = false;
    if (typeof mem.followup.started_ts !== "number") mem.followup.started_ts = 0;
    if (typeof mem.followup.last_sent_ts !== "number") mem.followup.last_sent_ts = 0;
    if (typeof mem.followup.next_due_ts !== "number") mem.followup.next_due_ts = 0;
    if (typeof mem.followup.count !== "number") mem.followup.count = 0;
    if (typeof mem.followup.cancelled !== "boolean") mem.followup.cancelled = false;
    if (typeof mem.followup.cancel_reason !== "string") mem.followup.cancel_reason = "";
    if (typeof mem.followup.cancelled_ts !== "number") mem.followup.cancelled_ts = 0;
  }

  return mem;
}

async function saveMemory(contactId, mem) {
  if (!redis) return;
  const key = `zia:${contactId}`;
  await redis.set(key, JSON.stringify(mem), "EX", 60 * 60 * 24 * 7);
}

// ✅ follow-up scheduler (Redis ZSET)
async function scheduleFollowupTick(contactId, mem) {
  if (!redis) return;
  const now = Date.now();

  if ((mem.inbound_count || 0) !== 1) return;
  if (mem.cierre_enviado) return;
  if (mem.followup?.active === true) return;

  mem.followup.active = true;
  mem.followup.cancelled = false;
  mem.followup.cancel_reason = "";
  mem.followup.cancelled_ts = 0;
  mem.followup.started_ts = mem.followup.started_ts || now;
  mem.followup.last_sent_ts = mem.followup.last_sent_ts || 0;
  mem.followup.count = mem.followup.count || 0;
  mem.followup.next_due_ts = mem.followup.next_due_ts || now + FOLLOWUP_INTERVAL_MS;

  await saveMemory(contactId, mem);
  await redis.zadd(FOLLOWUP_ZSET_KEY, String(mem.followup.next_due_ts), String(contactId));
}

async function cancelFollowupTick(contactId, mem, reason = "cancelled") {
  if (!redis) return;

  mem = mem || (await loadMemory(contactId));
  if (!mem.followup || typeof mem.followup !== "object") mem.followup = defaultMemory().followup;

  mem.followup.active = false;
  mem.followup.cancelled = true;
  mem.followup.cancel_reason = safeText(reason);
  mem.followup.cancelled_ts = Date.now();
  mem.followup.next_due_ts = 0;

  await saveMemory(contactId, mem);
  await redis.zrem(FOLLOWUP_ZSET_KEY, String(contactId));
}

async function processDueFollowupsTick(limit = FOLLOWUP_BATCH_LIMIT) {
  if (!redis) return;

  const now = Date.now();

  const due = await redis.zrangebyscore(
    FOLLOWUP_ZSET_KEY,
    "-inf",
    String(now),
    "LIMIT",
    0,
    limit
  );

  if (!due || due.length === 0) return;

  for (const contactId of due) {
    try {
      const mem = await loadMemory(contactId);

      if (mem.cierre_enviado) {
        await cancelFollowupTick(contactId, mem, "lead_closed");
        continue;
      }

      if ((mem.inbound_count || 0) >= 2) {
        await cancelFollowupTick(contactId, mem, "user_sent_second_message");
        continue;
      }

      if (mem.followup?.active !== true) {
        await redis.zrem(FOLLOWUP_ZSET_KEY, String(contactId));
        continue;
      }

      const started = mem.followup.started_ts || now;

      if (now - started > FOLLOWUP_MAX_WINDOW_MS) {
        await cancelFollowupTick(contactId, mem, "window_expired");
        continue;
      }

      if ((mem.followup.count || 0) >= FOLLOWUP_MAX_COUNT) {
        await cancelFollowupTick(contactId, mem, "max_count_reached");
        continue;
      }

      const reminderText =
        "👋✨ Solo paso por aquí rapidito…\n" +
        "¿Qué necesitas ahora mismo?\n" +
        "1) Página web 🚀\n" +
        "2) Bot para WhatsApp 🤖\n" +
        "3) Ambos 🔥";

      try {
        if (canSendUserFollowupViaManyChat()) {
          await sendUserFollowupViaManyChat(contactId, reminderText);
        } else {
          console.log("[followup_user] skipped (missing MANYCHAT_API_KEY)");
        }
      } catch (e) {
        console.error(
          "[followup_user] FAILED:",
          e?.response?.status,
          e?.response?.data || e?.message || e
        );
        mem.followup.next_due_ts = Date.now() + 10 * 60 * 1000;
        await saveMemory(contactId, mem);
        await redis.zadd(FOLLOWUP_ZSET_KEY, String(mem.followup.next_due_ts), String(contactId));
        continue;
      }

      mem.followup.last_sent_ts = now;
      mem.followup.count = (mem.followup.count || 0) + 1;

      if (mem.followup.count >= FOLLOWUP_MAX_COUNT) {
        await cancelFollowupTick(contactId, mem, "max_count_reached");
        continue;
      }

      mem.followup.next_due_ts = Date.now() + FOLLOWUP_INTERVAL_MS;
      await saveMemory(contactId, mem);
      await redis.zadd(FOLLOWUP_ZSET_KEY, String(mem.followup.next_due_ts), String(contactId));
    } catch (e) {
      console.error("❌ processDueFollowupsTick item error:", e?.response?.data || e?.message || e);
      try {
        const fallback = Date.now() + 10 * 60 * 1000;
        await redis.zadd(FOLLOWUP_ZSET_KEY, String(fallback), String(contactId));
      } catch (_) {}
    }
  }
}

// --- OpenAI ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ✅ PROMPT ajustado: entiende números + maneja “precio/preguntas raras” redirigiendo sin romper el flujo
function buildSystemPrompt() {
  return `
Eres Zia Bot, el asistente comercial de Zia Lab Agency. Hablas como una persona real, cercana y profesional, con tono relajado-formal en español natural (RD si aplica).

REGLAS CLAVE
- No repitas el saludo si ya existe conversación previa (si el historial ya tiene mensajes del bot).
- Mensajes cortos (máx. 2-3 líneas).
- Una sola pregunta por mensaje.
- Emojis variados y naturales (😊✨🚀🙌🧡).
- No uses etiquetas tipo “[CLIENTE]”.
- No hagas propuestas largas, diagnósticos extensos ni bullets.
- No inventes datos si el usuario no lo dijo.

OBJETIVO
Capturar el lead con SOLO 3 preguntas para estos 2 servicios:
1) Páginas web (landing, corporativa, menú/servicios, etc)
2) Bots para WhatsApp (ventas, citas, agenda, etc)

IMPORTANTE (MAPEO DE CAMPOS)
- Guarda la RESPUESTA de la pregunta #1 en: state.sector
- Guarda la RESPUESTA de la pregunta #2 en: state.servicio
- Guarda la RESPUESTA de la pregunta #3 (nombre/IG) en: state.redes

NORMALIZACIÓN (SÚPER IMPORTANTE)
- Si el usuario responde con número:
  - “1” = “Página web”
  - “2” = “Bot para WhatsApp”
  - “3” = “Ambos”
  Guarda el valor normalizado en state.sector.
- También acepta: “web”, “pagina”, “página”, “landing”, “corporativa” como Página web.
- Acepta: “bot”, “whatsapp”, “automatizar”, “citas”, “ventas” como Bot para WhatsApp.
- Acepta: “ambos”, “los dos”, “2 servicios” como Ambos.

MANEJO DE MENSAJES “RAROS” / FUERA DE FLUJO (PRECIO, TIEMPO, GARANTÍA, ETC)
- Si el usuario pregunta precio, tiempo, “cuánto cuesta”, “planes”, “promo”, o algo que NO responde la pregunta pendiente:
  1) Responde amable: “Te explico eso en un momentito 😊”
  2) Dile que para enviarlo correcto necesita 3 respuestas rápidas
  3) Repite EXACTAMENTE la pregunta que toca según pending
  4) MUY IMPORTANTE: NO inventes respuestas, NO avances estado si no respondió.
  (En ese caso, mantén state igual y pending igual.)

PREGUNTAS (en este orden, SIN botones; incluye opciones en el mismo mensaje)
1) (sector) ¿Qué necesitas ahora mismo?
“1) Página web 🚀  2) Bot para WhatsApp 🤖  3) Ambos 🔥”

2) (servicio) Pregunta dinámica según (sector):
- Si elige “Página web”:
  “¿Qué tipo de web necesitas: landing (1 página), corporativa, menú/delivery o tienda online?”
- Si elige “Bot para WhatsApp”:
  “¿Para qué lo quieres: ventas, agendar citas, responder precios/FAQ o todo automatizado?”
- Si elige “Ambos”:
  “Perfecto 🙌 ¿Qué quieres automatizar primero: las ventas por WhatsApp o la página web?”

3) (redes) Cierre:
“¿Cómo se llama tu negocio o pásame tu Instagram para revisarlo y prepararte el demo?”

REGLAS IMPORTANTES
- Si el usuario responde varias cosas en un mismo mensaje (incluyendo audio transcrito), extrae y guarda TODO lo que puedas para: sector, servicio y redes.
- Si ya tienes las 3 respuestas (sector + servicio + redes), NO preguntes más: cierra.

CIERRE (cuando ya tengas las 3):
Responde EXACTO:
“Perfecto 🙌 ya reviso tu negocio y te envío el demo con la propuesta del 30% OFF.”

y marca: cerrado=true, cierre_enviado=true y objetivo="calificado".

SALIDA OBLIGATORIA:
Devuelve SOLO JSON válido (sin texto extra), con este formato:
{
  "reply": "mensaje para el usuario",
  "state": {
    "sector": "",
    "servicio": "",
    "redes": "",
    "objetivo": "",
    "cerrado": false,
    "cierre_enviado": false,
    "pending": "sector|servicio|redes|none"
  }
}
`;
}

function inferPending(mem) {
  if (!mem.sector) return "sector";
  if (!mem.servicio) return "servicio";
  if (!mem.redes) return "redes";
  return "none";
}

function isAck(text) {
  const t = safeText(text).toLowerCase();
  return ["ok", "okay", "gracias", "hola", "mañana", "perfecto", "listo", "👍"].includes(t);
}

// --- Route ---
app.post("/mc/reply", async (req, res) => {
  const started = Date.now();

  try {
    console.log("[/mc/reply] hit", new Date().toISOString());

    if (!mustAuth(req)) {
      console.log("[/mc/reply] unauthorized");
      return res.status(401).json({ error: "unauthorized" });
    }

    const contactId = safeText(req.body?.contact_id);
    let userText = safeText(req.body?.user_text);

    console.log("[/mc/reply] contact_id:", contactId || "(missing)");
    console.log("[/mc/reply] user_text:", userText ? `"${userText}"` : "(empty)");

    if (!contactId) {
      return res.json({ reply: "¿Me confirmas tu mensaje otra vez, porfa? 😊" });
    }

    // ✅ audio -> transcribir
    let audioUrl = "";
    if (looksLikeAudioUrl(userText)) {
      audioUrl = userText;
    } else if (!userText) {
      audioUrl = getAudioUrl(req.body);
    }

    if (audioUrl) {
      console.log("[/mc/reply] audio_url detected:", audioUrl);
      const transcript = await transcribeAudioFromUrl(audioUrl, openai);

      if (transcript) {
        userText = transcript;
        console.log("[/mc/reply] transcript:", `"${userText}"`);
      } else {
        return res.json({
          reply: "No pude escuchar bien la nota de voz 😅 ¿Me lo puedes mandar en texto o reenviar el audio más claro?",
        });
      }
    }

    if (!userText) {
      return res.json({ reply: "Se me quedó el mensaje en blanco 😅 ¿Me lo repites en una línea?" });
    }

    // 1) cargar memoria
    const mem = await loadMemory(contactId);
    mem.pending = inferPending(mem);

    // ✅ contador inbound (para follow-ups)
    mem.inbound_count = (mem.inbound_count || 0) + 1;

    // ✅ si escribe 2do mensaje, cancelar recordatorios
    if (mem.inbound_count >= 2) {
      await cancelFollowupTick(contactId, mem, "user_sent_second_message");
    }

    // ✅ si es el primer mensaje, programar recordatorios
    if (mem.inbound_count === 1) {
      await scheduleFollowupTick(contactId, mem);
    }

    // Si ya cerró y el usuario escribe ack -> respuesta corta
    if (mem.cierre_enviado && isAck(userText)) {
      return res.json({ reply: "¡Listo! Ya quedó registrado 🙌 En breve te escribe un representante." });
    }

    // ✅ aceptar nombres/handles en paso "redes"
    if (mem.pending === "redes" && !mem.redes) {
      if (looksLikeLinkOrHandle(userText) || looksLikeBusinessName(userText)) {
        mem.redes = userText;
        mem.pending = inferPending(mem);
      }
    }

    // 2) armar mensajes
    const sys = buildSystemPrompt();

    const stateSnapshot = {
      sector: mem.sector,
      servicio: mem.servicio,
      redes: mem.redes,
      objetivo: mem.objetivo,
      cerrado: !!mem.cerrado,
      cierre_enviado: !!mem.cierre_enviado,
      pending: mem.pending,
    };

    const messages = [
      { role: "system", content: sys },
      { role: "system", content: `ESTADO ACTUAL: ${JSON.stringify(stateSnapshot)}` },
      ...clampHistory(mem.history, 10),
      { role: "user", content: userText },
    ];

    // 3) OpenAI (forzando JSON)
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 260,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    let parsed = safeParseModelJson(raw);

    if (!parsed) {
      console.error("[/mc/reply] JSON parse fail (raw):", raw);

      const repair = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 260,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Convierte el contenido del usuario en UN SOLO objeto JSON válido con el esquema: {reply:string, state:{sector,servicio,redes,objetivo,cerrado:boolean,cierre_enviado:boolean,pending}}. Sin texto extra.",
          },
          { role: "user", content: raw || "Responde con JSON válido siguiendo el esquema." },
        ],
      });

      const raw2 = repair.choices?.[0]?.message?.content || "";
      parsed = safeParseModelJson(raw2);

      if (!parsed) {
        console.error("[/mc/reply] JSON parse fail (repair raw):", raw2);
        return res.json({
          reply: "Se me fue la señal un momentito 😅 ¿Me repites eso en una línea, porfa?",
        });
      }
    }

    const reply = safeText(parsed.reply) || "¿Me repites eso en una línea, porfa? 😊";
    const newState = parsed.state || {};

    // 4) actualizar memoria (estado)
    mem.sector = safeText(newState.sector) || mem.sector;
    mem.servicio = safeText(newState.servicio) || mem.servicio;
    mem.redes = safeText(newState.redes) || mem.redes;
    mem.objetivo = safeText(newState.objetivo) || mem.objetivo;

    mem.cerrado = typeof newState.cerrado === "boolean" ? newState.cerrado : mem.cerrado;
    mem.cierre_enviado =
      typeof newState.cierre_enviado === "boolean" ? newState.cierre_enviado : mem.cierre_enviado;

    mem.pending = inferPending(mem);

    // 5) historial
    mem.history = clampHistory(
      [...(mem.history || []), { role: "user", content: userText }, { role: "assistant", content: reply }],
      12
    );

    await saveMemory(contactId, mem);

    // ✅ si ya cerró el lead, cancelar recordatorios
    if (mem.cierre_enviado) {
      await cancelFollowupTick(contactId, mem, "lead_closed");
    }

    // ✅ cuando el lead está completo y ya cerró -> avisar a tu WhatsApp (1 vez)
    const leadComplete = !!(mem.sector && mem.servicio && mem.redes && mem.cierre_enviado);

    if (leadComplete && !mem.admin_notified) {
      mem.admin_notified = true;
      await saveMemory(contactId, mem);

      const summary = buildLeadSummary({
        contactId,
        sector: mem.sector,
        servicio: mem.servicio,
        redes: mem.redes,
      });

      setImmediate(async () => {
        try {
          if (canNotifyAdminViaManyChat()) {
            await sendAdminViaManyChat(summary);
          } else if (canNotifyAdminViaMeta()) {
            await sendAdminViaMeta(summary);
            console.log("[admin_notify] sent via Meta ✅");
          } else {
            console.log("[admin_notify] skipped (missing MANYCHAT_API_KEY/ADMIN_SUBSCRIBER_ID and no Meta fallback)");
          }
        } catch (e) {
          console.error("[admin_notify] FAILED:", e?.response?.status, e?.response?.data || e?.message || e);
          try {
            if (canNotifyAdminViaMeta()) {
              await sendAdminViaMeta(summary);
              console.log("[admin_notify] fallback Meta ✅");
            }
          } catch (e2) {
            console.error("[admin_notify] Meta fallback FAILED:", e2?.response?.status, e2?.response?.data || e2?.message || e2);
          }
        }
      });
    }

    console.log("[/mc/reply] done in", Date.now() - started, "ms");
    return res.json({ reply });
  } catch (err) {
    console.error("[/mc/reply] ERROR:", err?.stack || err);
    return res.json({ reply: "Se me complicó un momentito 😅 ¿Me lo mandas de nuevo en una línea?" });
  }
});

// ✅ /health (se mantiene)
app.get("/health", (_req, res) => res.send("ok"));

// ✅ /tick (NUEVO) - UptimeRobot pega aquí para procesar follow-ups
app.get("/tick", async (req, res) => {
  try {
    const token = safeText(req.query?.token);
    if (!TICK_TOKEN || token !== TICK_TOKEN) return res.sendStatus(403);

    await processDueFollowupsTick();
    return res.status(200).send("tick ok");
  } catch (e) {
    console.error("[/tick] ERROR:", e?.stack || e?.message || e);
    return res.status(200).send("tick ok");
  }
});

app.listen(PORT, () => console.log("running on", PORT));
