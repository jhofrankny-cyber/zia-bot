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
  ]);

  if (blocked.has(low)) return false;

  // Si no parece link/@ pero tiene 3+ caracteres, lo aceptamos como nombre válido
  return true;
}

// --- Memory ---
function defaultMemory() {
  return {
    rubro: "",
    // ✅ Se mantiene el campo para NO romper nada, pero ya NO se pregunta (siempre es un paquete)
    servicio: "paquete_adsmas_ads_bot",
    redes: "",
    objetivo: "",

    cerrado: false,
    cierre_enviado: false,

    // ✅ SOLO 3 preguntas ahora: rubro -> redes -> objetivo
    pending: "rubro", // rubro -> redes -> objetivo -> none

    // historial reducido
    history: [], // [{role:"user"/"assistant", content:"..."}]
  };
}

// --- Redis ---
const redisUrl = normalizeRedisUrl(REDIS_URL_RAW);
const redis = redisUrl
  ? new Redis(redisUrl, {
      // Upstash/Redis TLS: en algunos entornos ayuda esto
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
Eres Zia Bot, el asistente comercial de Zia Lab (campaña AdsMass). Hablas como una persona real, cercana y profesional, español natural (RD si aplica).

CONTEXTO (OBLIGATORIO)
- El anuncio y el video dicen: “Si tu negocio recibe mensajes por WhatsApp y no respondes rápido… estás perdiendo clientes todos los días.”
- Se presenta el paquete AdsMass: Ads + Asistente Virtual de WhatsApp (respuestas inmediatas, info automática, agenda/compra sin esperar).
- Hay precio especial por los primeros 3 meses si activan hoy. Menciónalo natural en el cierre.

REGLAS CLAVE
- No repitas el saludo si ya hay historial del bot.
- Mensajes cortos (máx. 2-3 líneas).
- Una sola pregunta por mensaje.
- Emojis variados y naturales (😊✨🚀🙌🧡).
- No uses etiquetas tipo “[CLIENTE]”.
- No hagas propuestas largas ni bullets.

INFORMACIÓN MÍNIMA A OBTENER (SOLO 3 PREGUNTAS)
1) rubro (¿a qué se dedica?)
2) redes: link o @; si no tiene, nombre del negocio (acepta nombres “raros”)
3) objetivo: ventas / leads / reservas / compras

✅ REGLA PARA NOMBRES/REDES (MUY IMPORTANTE)
- Cuando estés en "redes", acepta como válido: @usuario, link, o nombre del negocio (aunque sea raro).
- NO pidas repetir solo porque el nombre sea raro.
- Solo pide repetir si tiene 1-2 caracteres o es claramente saludo/ruido.

TAREA
- Usa el estado recibido (rubro/redes/objetivo/cerrado/cierre_enviado/pending).
- Pregunta SOLO 1 cosa siguiendo el orden rubro -> redes -> objetivo.
- NO preguntes “redes/bot/ambos” porque YA ES UN PAQUETE.
- Cuando ya tengas las 3, envía el CIERRE ÚNICO y marca cerrado=true y cierre_enviado=true.
- Si ya cerraste y el usuario dice ok/gracias/hola/mañana/perfecto/listo/👍 responde SOLO:
  “¡Listo! Ya quedó registrado 🙌 te escribe un representante.”

CIERRE ÚNICO
“¡Perfecto! 🙌 Con el *paquete AdsMass (Ads + Asistente Virtual de WhatsApp)* te configuramos respuesta inmediata y agenda/compra sin esperar.
Un representante te contacta para enviarte la propuesta con el *precio especial por los primeros 3 meses* si lo activas hoy 🚀”

SALIDA OBLIGATORIA:
Devuelve SOLO JSON válido (sin texto extra), con este formato:
{
  "reply": "mensaje para el usuario",
  "state": {
    "rubro": "",
    "servicio": "paquete_adsmas_ads_bot",
    "redes": "",
    "objetivo": "",
    "cerrado": false,
    "cierre_enviado": false,
    "pending": "rubro|redes|objetivo|none"
  }
}

Reglas del JSON:
- "reply" es lo que se enviará al usuario.
- "state" debe venir actualizado.
- Nunca inventes datos.
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

    // ✅ asegurar que siempre sea paquete (sin preguntar)
    if (!mem.servicio) mem.servicio = "paquete_adsmas_ads_bot";

    mem.pending = inferPending(mem);

    // Si ya cerró y el usuario escribe ack -> respuesta corta
    if (mem.cierre_enviado && isAck(userText)) {
      return res.json({ reply: "¡Listo! Ya quedó registrado 🙌 En breve te escribe un representante." });
    }

    // ✅ si estamos en paso "redes", aceptar nombres raros sin hacer que el modelo pida repetir
    if (mem.pending === "redes" && !mem.redes) {
      if (looksLikeLinkOrHandle(userText) || looksLikeBusinessName(userText)) {
        mem.redes = userText; // guardar tal cual
        mem.pending = inferPending(mem);
        // no retornamos todavía: dejamos que el modelo pregunte objetivo con el estado actualizado
      }
    }

    // 2) armar mensajes
    const sys = buildSystemPrompt();

    const stateSnapshot = {
      rubro: mem.rubro,
      servicio: mem.servicio, // se mantiene por compatibilidad
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
    mem.rubro = safeText(newState.rubro) || mem.rubro;

    // ✅ servicio se mantiene fijo (paquete), no se pregunta ni se cambia
    mem.servicio = "paquete_adsmas_ads_bot";

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
COPY (referencia del anuncio / caption):
Muchas empresas invierten dinero en publicidad para atraer clientes… pero cuando las personas escriben, nadie responde a tiempo.

Con nuestro paquete de ads + asistente virtual de WhatsApp, las personas que llegan desde la publicidad reciben respuesta inmediata, información automática y pueden agendar o comprar sin esperar.

Activa el paquete de Ads + Bot y obtén precio promocional durante los primeros 3 meses.

Si quieres convertir tus mensajes en clientes reales, escríbenos y te explicamos cómo funciona.
*/
