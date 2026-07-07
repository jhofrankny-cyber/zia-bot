const express = require("express");
let Redis = null;
try {
  Redis = require("ioredis");
} catch (err) {
  console.warn("[startup] ioredis no está instalado; se usará memoria temporal sin Redis.");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ENV
const PORT = process.env.PORT || 3000;
const MC_AUTH_TOKEN = process.env.MC_AUTH_TOKEN || "";
const REDIS_URL_RAW = process.env.REDIS_URL || "";
const ADVISOR_TEXT = process.env.ZIA_ADVISOR_TEXT || "Un asesor de ZIA Lab te contactará lo antes posible.";

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
  if (u.startsWith("redis://")) return "rediss://" + u.slice("redis://".length);
  return u;
}

function stripAccents(text) {
  return safeText(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[¡!¿?.,;:()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampHistory(history, max = 12) {
  if (!Array.isArray(history)) return [];
  return history.slice(-max);
}

function optionNumber(text) {
  const t = normalizeText(text);
  const match = t.match(/^([1-9])\b/);
  return match ? match[1] : "";
}

function hasAny(text, words) {
  const t = normalizeText(text);
  return words.some((w) => t.includes(normalizeText(w)));
}

function isAck(text) {
  const t = normalizeText(text);
  return ["ok", "okay", "gracias", "perfecto", "listo", "bien", "dale", "👍"].includes(t);
}

function isGreetingOnly(text) {
  const t = normalizeText(text);
  return ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "saludos", "hey", "hello"].includes(t);
}

function isNoise(text) {
  const s = safeText(text);
  if (!s) return true;
  const t = normalizeText(s);
  return s.length <= 1 || [".", "..", "...", "👍", "🙏"].includes(s) || ["", "si", "sí", "no"].includes(t);
}

// --- Memory ---
function defaultMemory() {
  return {
    // Compatibilidad con versiones anteriores
    rubro: "",
    servicio: "",
    redes: "",
    objetivo: "",
    cerrado: false,
    cierre_enviado: false,

    // Flujo simple para leads desde video
    campaign: "zia_video_leads",
    pending: "business_name",
    business_name: "",
    service_interest: "",
    status: "nuevo_lead",
    human_handoff: false,

    history: []
  };
}

function mergeDefaults(mem) {
  return { ...defaultMemory(), ...(mem || {}) };
}

// --- Redis ---
const redisUrl = normalizeRedisUrl(REDIS_URL_RAW);
const redis = redisUrl && Redis
  ? new Redis(redisUrl, {
      tls: redisUrl.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    })
  : null;

// Fallback local para desarrollo o despliegues sin REDIS_URL.
// En producción con varias instancias, configura REDIS_URL para persistencia compartida.
const localMemory = new Map();

async function loadMemory(contactId) {
  const key = `zia:${contactId}`;
  if (!redis) return mergeDefaults(localMemory.get(key) || defaultMemory());
  const raw = await redis.get(key);
  try {
    return raw ? mergeDefaults(JSON.parse(raw)) : defaultMemory();
  } catch (e) {
    console.error("[memory] parse error", e?.message || e);
    return defaultMemory();
  }
}

async function saveMemory(contactId, mem) {
  const key = `zia:${contactId}`;
  if (!redis) {
    localMemory.set(key, mergeDefaults(mem));
    return;
  }
  await redis.set(key, JSON.stringify(mem), "EX", 60 * 60 * 24 * 14);
}

function resetMemoryKeepHistory(mem) {
  const fresh = defaultMemory();
  fresh.history = clampHistory(mem?.history || [], 6);
  return fresh;
}

// --- Copy ---
function askBusinessName() {
  return "¡Hola! 👋 Gracias por escribir a ZIA Lab.\n\nPara brindarte una atención más personalizada, primero dime: ¿cuál es el nombre de tu negocio?";
}

function askServiceInterest() {
  return "Perfecto 🚀 ¿En cuál servicio estás interesado?\n\n1️⃣ Manejo de redes sociales\n2️⃣ Publicidad en Meta / Facebook Ads\n3️⃣ Bot para WhatsApp\n4️⃣ Página web\n5️⃣ Branding\n6️⃣ Foto y video\n7️⃣ Asesoría para saber qué necesito";
}

function finalLeadReply(mem) {
  mem.status = "asesoria_pendiente";
  mem.human_handoff = true;
  mem.cerrado = true;
  mem.cierre_enviado = true;
  mem.pending = "closed";

  return `Listo ✅ Ya registré tu solicitud.\n\nNegocio: ${mem.business_name}\nInterés: ${mem.service_interest}\n\n${ADVISOR_TEXT}`;
}

function closedReply() {
  return "¡Listo! Ya tu solicitud quedó registrada 🙌 En breve te escribe un asesor de ZIA Lab.";
}

// --- Parsers ---
function parseServiceInterest(text) {
  const n = optionNumber(text);
  const map = {
    "1": "Manejo de redes sociales",
    "2": "Publicidad en Meta / Facebook Ads",
    "3": "Bot para WhatsApp",
    "4": "Página web",
    "5": "Branding",
    "6": "Foto y video",
    "7": "Asesoría para saber qué necesito",
  };
  if (map[n]) return map[n];

  if (hasAny(text, ["redes", "instagram", "facebook", "contenido", "manejo de redes", "social media"])) {
    return "Manejo de redes sociales";
  }
  if (hasAny(text, ["publicidad", "ads", "meta", "anuncio", "campaña", "campanas", "facebook ads", "meta ads"])) {
    return "Publicidad en Meta / Facebook Ads";
  }
  if (hasAny(text, ["bot", "whatsapp", "automatizar", "automatizacion", "automatización", "crm", "chatbot"])) {
    return "Bot para WhatsApp";
  }
  if (hasAny(text, ["web", "pagina", "página", "website", "tienda online", "ecommerce", "landing"])) {
    return "Página web";
  }
  if (hasAny(text, ["branding", "logo", "marca", "identidad", "brandbook", "diseño de marca", "diseno de marca"])) {
    return "Branding";
  }
  if (hasAny(text, ["foto", "video", "audiovisual", "reels", "fotografia", "fotografía", "grabacion", "grabación"])) {
    return "Foto y video";
  }
  if (hasAny(text, ["asesoria", "asesoría", "no se", "no sé", "orientacion", "orientación", "ayuda", "que necesito", "qué necesito"])) {
    return "Asesoría para saber qué necesito";
  }

  if (safeText(text).length >= 3 && !isGreetingOnly(text)) return safeText(text);
  return "";
}

function rememberHistory(mem, userText, reply) {
  mem.history = clampHistory(
    [...(mem.history || []), { role: "user", content: userText }, { role: "assistant", content: reply }],
    12
  );
}

function appendLeadSummary(mem) {
  return {
    campaign: mem.campaign,
    business_name: mem.business_name,
    service_interest: mem.service_interest,
    status: mem.status,
    human_handoff: mem.human_handoff,
  };
}

function handleConversation(mem, userText) {
  const text = safeText(userText);

  // Reinicio manual
  if (hasAny(text, ["reiniciar", "empezar de nuevo", "inicio", "menu", "menú"])) {
    const fresh = resetMemoryKeepHistory(mem);
    return { mem: fresh, reply: askBusinessName() };
  }

  // Regla de oro: cuando el lead ya está cerrado/pasado a asesor, el bot no sigue calificando ni haciendo preguntas.
  if (mem.cierre_enviado || mem.pending === "closed" || mem.human_handoff) {
    if (isAck(text) || isGreetingOnly(text)) return { mem, reply: closedReply() };
    return { mem, reply: "Ya tu solicitud quedó registrada 🙌 Un asesor de ZIA Lab te escribirá en breve. Si quieres iniciar otra consulta, escribe MENÚ." };
  }

  switch (mem.pending) {
    case "business_name": {
      if (isNoise(text) || isGreetingOnly(text)) {
        return { mem, reply: askBusinessName() };
      }
      mem.business_name = text;
      mem.pending = "service_interest";
      return { mem, reply: askServiceInterest() };
    }

    case "service_interest": {
      const service = parseServiceInterest(text);
      if (!service) {
        return { mem, reply: askServiceInterest() };
      }
      mem.service_interest = service;
      mem.servicio = service; // compatibilidad con campos anteriores
      return { mem, reply: finalLeadReply(mem) };
    }

    default: {
      mem.pending = "business_name";
      return { mem, reply: askBusinessName() };
    }
  }
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

    const contactId = safeText(req.body?.contact_id || req.body?.from || req.body?.phone || req.body?.wa_id);
    const userText = safeText(req.body?.user_text || req.body?.text || req.body?.message);

    console.log("[/mc/reply] contact_id:", contactId || "(missing)");
    console.log("[/mc/reply] user_text:", userText ? `\"${userText}\"` : "(empty)");

    if (!contactId) {
      return res.json({ reply: "¿Me confirmas tu mensaje otra vez, porfa? 😊" });
    }
    if (!userText) {
      return res.json({ reply: "Se me quedó el mensaje en blanco 😅 ¿Me lo repites en una línea?" });
    }

    let mem = await loadMemory(contactId);
    const result = handleConversation(mem, userText);
    mem = mergeDefaults(result.mem);
    const reply = safeText(result.reply) || askBusinessName();

    rememberHistory(mem, userText, reply);
    await saveMemory(contactId, mem);

    console.log("[/mc/reply] state:", JSON.stringify(appendLeadSummary(mem)));
    console.log("[/mc/reply] done in", Date.now() - started, "ms");

    return res.json({ reply, lead: appendLeadSummary(mem) });
  } catch (err) {
    console.error("[/mc/reply] ERROR:", err?.stack || err);
    return res.json({ reply: "Se me complicó un momentito 😅 ¿Me lo mandas de nuevo en una línea?" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log("running on", PORT));
