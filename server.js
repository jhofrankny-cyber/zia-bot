const express = require("express");
const Redis = require("ioredis");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ENV
const PORT = process.env.PORT || 3000;
const MC_AUTH_TOKEN = process.env.MC_AUTH_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const REDIS_URL_RAW = process.env.REDIS_URL || "";

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
  // Upstash suele requerir TLS => rediss://
  // Si te llegó redis:// lo convertimos a rediss://
  if (u.startsWith("redis://")) return "rediss://" + u.slice("redis://".length);
  return u;
}

function clampHistory(history, max = 10) {
  if (!Array.isArray(history)) return [];
  return history.slice(-max);
}

// ✅ NUEVO: detectar @ / links / nombres raros sin “rechazarlos”
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

  // Evitar confundir respuestas típicas con “nombre”
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

  // Si no parece link/@ pero tiene 3+ caracteres, lo aceptamos como nombre raro válido.
  // (permite emojis, números, guiones, mayúsculas, abreviaciones, letras repetidas, etc.)
  return true;
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

    // qué falta pedir (evita loops)
    pending: "sector", // sector -> servicio -> redes -> objetivo -> none

    // historial reducido
    history: [], // [{role:"user"/"assistant", content:"..."}]
  };
}

// --- Redis ---
const redisUrl = normalizeRedisUrl(REDIS_URL_RAW);
const redis = redisUrl
  ? new Redis(redisUrl, {
      // Upstash/Redis TLS: en algunos entornos ayuda esto
      tls: redisUrl.startsWith("rediss://")
        ? { rejectUnauthorized: false }
        : undefined,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    })
  : null;

async function loadMemory(contactId) {
  if (!redis) return defaultMemory();
  const key = `zia:${contactId}`;
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : defaultMemory();
}

async function saveMemory(contactId, mem) {
  if (!redis) return;
  const key = `zia:${contactId}`;
  // TTL 7 días
  await redis.set(key, JSON.stringify(mem), "EX", 60 * 60 * 24 * 7);
}

// --- OpenAI ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
Capturar el lead con SOLO 3 preguntas. No envíes demo, no hables de precios, no menciones descuentos.

PREGUNTAS (en este orden, SIN botones; incluye ejemplos en el mismo mensaje)
1) (sector) Tipo de negocio:
   “¿Qué tipo de negocio tienes? Ejemplos: clínica dental, spa, salón de belleza, consultorio, barbería, estudio, otro.”

2) (servicio) Qué quiere automatizar primero:
   “¿Qué te gustaría automatizar primero en WhatsApp? Ejemplos: agendar citas, confirmar/recordatorios, reagendar, información y precios.”

3) (redes) Volumen semanal:
   “Aprox. ¿cuántas citas manejan por semana? Ejemplos: 5, 15, 30, 60+.”

✅ REGLA PARA RESPUESTAS CORTAS (MUY IMPORTANTE)
- Cuando estés en el paso "redes" (pending = redes), acepta como válido números o rangos aunque sean cortos: "5", "15", "30", "60+", "más de 60".
- NO pidas repetir solo por ser corto.
- Solo pide repetir si viene vacío, o es ruido tipo "...", o solo emojis sueltos.

TAREA
- Usa el estado recibido (sector/servicio/redes/objetivo/cerrado/cierre_enviado/pending).
- Interpreta respuestas de una palabra según la última pregunta (pending).
- Pregunta SOLO 1 cosa siguiendo el orden sector -> servicio -> redes.
- Cuando ya tengas las 3 (sector, servicio, redes), NO preguntes más. En ese mismo mensaje:
  - Envía el cierre corto EXACTO: “¡Listo! Ya quedó registrado 🙌 te escribe un representante.”
  - Marca cerrado=true y cierre_enviado=true.
  - Setea objetivo="calificado" (para que pending pase a "none").

- Si ya cerraste y el usuario dice ok/gracias/hola/mañana/perfecto/listo/👍 responde SOLO:
  “¡Listo! Ya quedó registrado 🙌 te escribe un representante.”

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
    "pending": "sector|servicio|redes|objetivo|none"
  }
}

Reglas del JSON:
- "reply" debe ser lo que se enviará al usuario.
- "state" debe venir actualizado según el último mensaje del usuario y el estado previo.
- Nunca inventes datos: si no lo dijo, déjalo igual.
`;
}

function inferPending(mem) {
  if (!mem.sector) return "sector";
  if (!mem.servicio) return "servicio";
  if (!mem.redes) return "redes";
  if (!mem.objetivo) return "objetivo";
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
    // Logs mínimos (Render)
    console.log("[/mc/reply] hit", new Date().toISOString());

    if (!mustAuth(req)) {
      console.log("[/mc/reply] unauthorized");
      return res.status(401).json({ error: "unauthorized" });
    }

    const contactId = safeText(req.body?.contact_id);
    const userText = safeText(req.body?.user_text);

    console.log("[/mc/reply] contact_id:", contactId || "(missing)");
    console.log("[/mc/reply] user_text:", userText ? `"${userText}"` : "(empty)");

    if (!contactId) {
      return res.json({ reply: "¿Me confirmas tu mensaje otra vez, porfa? 😊" });
    }
    if (!userText) {
      return res.json({ reply: "Se me quedó el mensaje en blanco 😅 ¿Me lo repites en una línea?" });
    }

    // 1) cargar memoria
    const mem = await loadMemory(contactId);
    mem.pending = inferPending(mem);

    // Si ya cerró y el usuario escribe ack -> respuesta corta
    if (mem.cierre_enviado && isAck(userText)) {
      return res.json({ reply: "¡Listo! Ya quedó registrado 🙌 En breve te escribe un representante." });
    }

    // ✅ NUEVO: si estamos en paso "redes", aceptar nombres raros sin hacer que el modelo pida repetir
    if (mem.pending === "redes" && !mem.redes) {
      if (looksLikeLinkOrHandle(userText) || looksLikeBusinessName(userText)) {
        mem.redes = userText; // guardar tal cual
        mem.pending = inferPending(mem);
        // no retornamos todavía: dejamos que el modelo pregunte objetivo con el estado ya actualizado
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
      response_format: { type: "json_object" }, // <-- clave para no romper JSON
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("[/mc/reply] JSON parse fail:", raw);
      return res.json({
        reply: "Se me fue la señal un momentito 😅 ¿Me repites eso en una línea, porfa?",
      });
    }

    const reply = safeText(parsed.reply) || "¿Me repites eso en una línea, porfa? 😊";
    const newState = parsed.state || {};

    // 4) actualizar memoria (estado)
    mem.sector = safeText(newState.sector) || mem.sector;
    mem.servicio = safeText(newState.servicio) || mem.servicio;

    // ✅ NUEVO: si ya guardamos redes arriba, no la sobreescribas con vacío
    mem.redes = safeText(newState.redes) || mem.redes;

    mem.objetivo = safeText(newState.objetivo) || mem.objetivo;

    mem.cerrado = typeof newState.cerrado === "boolean" ? newState.cerrado : mem.cerrado;
    mem.cierre_enviado =
      typeof newState.cierre_enviado === "boolean" ? newState.cierre_enviado : mem.cierre_enviado;

    // recalcular pending de forma determinista (anti-loop)
    mem.pending = inferPending(mem);

    // 5) historial
    mem.history = clampHistory(
      [...(mem.history || []), { role: "user", content: userText }, { role: "assistant", content: reply }],
      12
    );

    await saveMemory(contactId, mem);

    console.log("[/mc/reply] done in", Date.now() - started, "ms");
    return res.json({ reply });
  } catch (err) {
    console.error("[/mc/reply] ERROR:", err?.stack || err);
    return res.json({ reply: "Se me complicó un momentito 😅 ¿Me lo mandas de nuevo en una línea?" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log("running on", PORT));
