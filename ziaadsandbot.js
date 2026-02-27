// index.js (ManyChat -> Zia Bot / AdsMass Asistente Virtual)
// ✅ CAMBIOS APLICADOS:
// 1) Se elimina la “pregunta #2” (servicio: redes/bot/ambos). Ahora es un PAQUETE.
// 2) Se ajusta bienvenida + flujo + cierre para que esté 100% acorde al caption y guion del video.
//    (3 preguntas en total: rubro -> redes -> objetivo)
// ⚠️ Regla de oro: no se eliminan flujos que ya funcionan; solo se ajusta el state/prompt.

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
    low.includes("wa.me") ||
    low.includes("facebook") ||
    low.includes("fb")
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
    "👍",
    "...",
    "..",
    ".",
    "oferta",
    "promo",
    "promocion",
    "promoción",
    "precio",
    "costo",
    "cuanto",
    "cuánto",
    "info",
    "informacion",
    "información",
  ]);

  if (blocked.has(low)) return false;

  // Si no parece link/@ pero tiene 3+ caracteres, lo aceptamos como nombre raro válido.
  return true;
}

// --- Memory ---
function defaultMemory() {
  return {
    // ✅ 3 datos (ya NO existe "servicio" porque es un paquete)
    rubro: "",
    redes: "",
    objetivo: "",

    cerrado: false,
    cierre_enviado: false,

    // qué falta pedir (evita loops)
    pending: "rubro", // rubro -> redes -> objetivo -> none

    // historial reducido
    history: [], // [{role:"user"/"assistant", content:"..."}]
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
Eres Zia Bot, el asistente comercial de Zia Lab Agency. Hablas como una persona real, cercana y profesional, en español natural (RD si aplica).

CONTEXTO (CAPTION + GUION)
- Mensaje del video: “Si tu negocio recibe mensajes por WhatsApp y no respondes rápido… estás perdiendo clientes todos los días.”
- Oferta: Paquete “AdsMass Asistente Virtual” (Anuncios + Asistente Virtual en WhatsApp).
  Beneficio: respuesta inmediata, info automática y ayuda a agendar o comprar sin esperar.
  Promo: precio especial / 30% OFF durante los primeros 3 meses si activa hoy.

REGLAS CLAVE
- No repitas el saludo si ya existe conversación previa (si el historial ya tiene mensajes del bot).
- Mensajes cortos (máx. 2-3 líneas).
- Una sola pregunta por mensaje.
- Emojis naturales (😊✨🚀🙌🧡).
- No uses etiquetas tipo “[CLIENTE]”.
- No hagas propuestas largas, diagnósticos extensos ni bullets.
- No inventes datos si el usuario no lo dijo.

✅ REGLA PARA NOMBRES/REDES (MUY IMPORTANTE)
- Cuando estés en el paso "redes" (pending = redes), acepta como válido cualquier texto que parezca:
  a) un @usuario,
  b) un link,
  c) o un NOMBRE de negocio aunque sea raro (emojis, números, guiones, mayúsculas, etc.).
- NO pidas repetir solo porque el nombre es “raro”.
- Solo pide repetir si el mensaje tiene 1-2 caracteres, o es saludo/ack (“hola”, “ok”, “gracias”), o ruido tipo "..." o solo emojis sueltos.
- Si el texto NO parece link/@ pero tiene 3+ caracteres, guárdalo como nombre del negocio en state.redes.

📌 INFORMACIÓN MÍNIMA A OBTENER (SOLO 3 PREGUNTAS)
1) rubro (¿qué tipo de negocio es?)
2) redes (su @ o link; si no tiene, nombre del negocio)
3) objetivo (ventas / leads / reservas / compras)

CÓMO RESPONDER SI PREGUNTAN POR LA OFERTA / PROMO
- Si el usuario pregunta “¿qué están promocionando?”, “¿cuál es la oferta?”, “¿cómo funciona?”:
  Responde claro y corto:
  “Estamos promocionando el paquete AdsMass 😊 Incluye anuncios para atraer clientes + un asistente en WhatsApp que responde al instante y ayuda a agendar o comprar. Si lo activas hoy, tienes precio especial/30% OFF los primeros 3 meses.”
  Luego haz la pregunta que toque según pending (sin saltarte el orden).

CÓMO RESPONDER SI PREGUNTAN “¿QUÉ ES UN BOT?”
- Responde simple:
  “Es un asistente automático en WhatsApp ✅ Responde al instante, da información y guía al cliente para agendar o comprar.”
  Luego haz la pregunta que toque según pending.

TAREA
- Usa el estado recibido (rubro/redes/objetivo/cerrado/cierre_enviado/pending).
- Interpreta respuestas cortas según la última pregunta (pending).
- Pregunta SOLO 1 cosa siguiendo el orden: rubro -> redes -> objetivo.
- Cuando ya tengas las 3, envía el CIERRE ÚNICO y marca cerrado=true y cierre_enviado=true.
- Si ya cerraste y el usuario dice ok/gracias/hola/mañana/perfecto/listo/👍 responde SOLO:
  “¡Listo! Ya quedó registrado 🙌 te escribe un representante.”

BIENVENIDA (cuando pending=rubro y no hay historial del bot)
“Hola 👋 Si tu negocio recibe mensajes por WhatsApp y no respondes rápido, se pierden clientes 😅
Con AdsMass (Ads + Asistente Virtual) respondes al instante y pueden agendar o comprar.
¿Qué tipo de negocio tienes?”

CIERRE ÚNICO (usa el objetivo final)
“¡Perfecto! 😊 Entonces con *AdsMass* vamos a ayudarte a lograr *[objetivo]* con anuncios + respuestas automáticas en WhatsApp para que no se pierdan clientes.
Un representante de Zia Lab te contacta en breve con la propuesta y el 30% OFF por los primeros 3 meses 🚀”

SALIDA OBLIGATORIA:
Devuelve SOLO JSON válido (sin texto extra), con este formato:
{
  "reply": "mensaje para el usuario",
  "state": {
    "rubro": "",
    "redes": "",
    "objetivo": "",
    "cerrado": false,
    "cierre_enviado": false,
    "pending": "rubro|redes|objetivo|none"
  }
}

Reglas del JSON:
- "reply" debe ser lo que se enviará al usuario.
- "state" debe venir actualizado según el último mensaje del usuario y el estado previo.
- Nunca inventes datos: si el usuario no lo dijo, déjalo igual.
`;
}

function inferPending(mem) {
  if (!mem.rubro) return "rubro";
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

    // ✅ Si estamos en paso "redes", aceptar nombres raros sin hacer que el modelo pida repetir
    if (mem.pending === "redes" && !mem.redes) {
      if (looksLikeLinkOrHandle(userText) || looksLikeBusinessName(userText)) {
        mem.redes = userText; // guardar tal cual
        mem.pending = inferPending(mem);
      }
    }

    // 2) armar mensajes
    const sys = buildSystemPrompt();

    const stateSnapshot = {
      rubro: mem.rubro,
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
      max_tokens: 280,
      response_format: { type: "json_object" },
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
    mem.rubro = safeText(newState.rubro) || mem.rubro;

    // ✅ si ya guardamos redes arriba, no la sobreescribas con vacío
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

/*
Referencia (caption/idea) — NO se ejecuta:
Hablamos sobre cómo los negocios pierden clientes y dinero por no responder rápido los mensajes de WhatsApp.
Paquete AdsMass Asistente Virtual: respuestas inmediatas, info automática y permite agendar o comprar sin esperar.
Precio especial para los primeros 3 meses si activas hoy el paquete.
*/
