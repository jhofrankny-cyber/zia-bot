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
const DEMO_URL = process.env.ZIA_BOT_TIENDA_DEMO_URL || "";
const ADVISOR_TEXT = process.env.ZIA_ADVISOR_TEXT || "En breve te escribe un asesor de ZIA Lab.";

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

function readableList(values) {
  const arr = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!arr.length) return "";
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(", ")} y ${arr[arr.length - 1]}`;
}

function demoLine() {
  return DEMO_URL ? `\n\nDemo: ${DEMO_URL}` : "";
}

// --- Memory ---
function defaultMemory() {
  return {
    // Campos anteriores conservados por compatibilidad con la versión previa
    rubro: "",
    servicio: "",
    redes: "",
    objetivo: "",
    cerrado: false,
    cierre_enviado: false,

    // Nuevo flujo ZIA Bot Tienda
    campaign: "zia_bot_tienda",
    pending: "intent",
    intent: "",
    business_type: "",
    receives_orders: "",
    messages_volume: "",
    business_name: "",
    business_main: "",
    has_catalog: "",
    products_count: "",
    needs: [],
    contact_name: "",
    contact_preference: "",
    plan_suggested: "",
    demo_sent: false,
    status: "nuevo_lead",
    human_handoff: false,

    history: []
  };
}

function mergeDefaults(mem) {
  return { ...defaultMemory(), ...(mem || {}), needs: Array.isArray(mem?.needs) ? mem.needs : [] };
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
function introReply() {
  return "Hola 👋 Soy el asistente de ZIA Lab.\n\nVi que te interesa automatizar tu tienda por WhatsApp con un bot que atiende clientes, toma pedidos y organiza ventas en un CRM.\n\n¿En qué te ayudo?\n1️⃣ Quiero ver una demo\n2️⃣ Quiero saber precios\n3️⃣ Quiero automatizar mi tienda\n4️⃣ Hablar con un asesor";
}

function askBusinessType() {
  return "Perfecto 🚀 ¿Qué tipo de negocio tienes?\n\n1️⃣ Tienda virtual\n2️⃣ Belleza / cosméticos\n3️⃣ Ropa / accesorios\n4️⃣ Suplementos / productos naturales\n5️⃣ Celulares / accesorios\n6️⃣ Otro";
}

function askReceivesOrders() {
  return "Excelente. ¿Actualmente recibes pedidos por WhatsApp?\n\n1️⃣ Sí, todos los días\n2️⃣ Sí, pero pocos\n3️⃣ Aún no, pero quiero empezar";
}

function demoReply() {
  return `Perfecto. ZIA Bot Tienda puede responder clientes, tomar pedidos y registrar ventas en un CRM sin que tengas que atender todo manualmente.${demoLine()}\n\n¿Quieres que un asesor te explique cuál plan te conviene?\n1️⃣ Sí, quiero asesoría\n2️⃣ Ver planes primero`;
}

function askMessagesVolume() {
  return "Claro. Para recomendarte el plan ideal, dime: ¿cuántos mensajes recibes aproximadamente al día por WhatsApp?\n\n1️⃣ Menos de 10\n2️⃣ Entre 10 y 30\n3️⃣ Más de 30\n4️⃣ No estoy seguro/a";
}

function pricingReply() {
  return "Estos son nuestros planes de ZIA Bot Tienda:\n\n🟠 Tienda Basic: desde RD$2,500/mes + setup RD$5,000.\n🟠 Tienda Start: RD$6,500/mes + setup RD$12,000.\n🟠 Tienda Elite: RD$12,000/mes + setup desde RD$20,000.\n\n¿Qué deseas hacer ahora?\n1️⃣ Recomiéndame un plan\n2️⃣ Quiero una demo\n3️⃣ Hablar con asesor";
}

function askBusinessName() {
  return "Excelente 🔥 ¿Cuál es el nombre de tu negocio?";
}

function askBusinessMain() {
  return "Perfecto. ¿Qué vendes principalmente?";
}

function askCatalog() {
  return "¿Tienes catálogo, lista de productos o menú de precios?\n\n1️⃣ Sí\n2️⃣ No todavía\n3️⃣ Lo manejo por fotos / Instagram";
}

function askProductsCount() {
  return "¿Cuántos productos te gustaría automatizar al inicio?\n\n1️⃣ Hasta 20 productos\n2️⃣ Hasta 60 productos\n3️⃣ Más de 60 productos\n4️⃣ No estoy seguro/a";
}

function askNeeds() {
  return "¿Qué necesitas que haga el bot? Puedes responder con números o escribirlo.\n\n1️⃣ Responder preguntas frecuentes\n2️⃣ Tomar pedidos\n3️⃣ Pedir dirección y método de pago\n4️⃣ Recibir comprobantes\n5️⃣ Organizar clientes en CRM\n6️⃣ Dar seguimiento a interesados";
}

function askContactPreference() {
  return "Perfecto. ¿Prefieres agendar una llamada o que un asesor te escriba por WhatsApp?\n\n1️⃣ Agendar llamada\n2️⃣ Que me escriban por WhatsApp";
}

function askContactName() {
  return "Claro. Te conectaré con un asesor de ZIA Lab.\n\nAntes, dime tu nombre:";
}

function finalLeadReply(mem) {
  const plan = suggestPlan(mem);
  mem.plan_suggested = plan;
  mem.status = "asesoria_pendiente";
  mem.human_handoff = true;
  mem.cerrado = true;
  mem.cierre_enviado = true;
  mem.pending = "closed";

  const needsText = readableList(mem.needs);
  return `Listo ✅ Ya registré tu solicitud.\n\nSegún lo que me compartiste, el plan sugerido inicialmente sería: ${plan}.\n\nUn asesor de ZIA Lab revisará tu negocio${needsText ? ` y lo que necesitas: ${needsText}` : ""}. ${ADVISOR_TEXT}`;
}

function advisorFinalReply(mem) {
  mem.status = "asesoria_pendiente";
  mem.human_handoff = true;
  mem.cerrado = true;
  mem.cierre_enviado = true;
  mem.pending = "closed";
  return `Perfecto, ${mem.contact_name || ""} ✅ Ya te conecto con un asesor de ZIA Lab.\n\nMientras tanto, puedes escribirnos qué necesitas automatizar en tu WhatsApp.`.replace("Perfecto,  ✅", "Perfecto ✅");
}

function closedReply() {
  return "¡Listo! Ya quedó registrado 🙌 En breve te escribe un representante.";
}

// --- Parsers ---

function parseKeywordIntent(text) {
  if (hasAny(text, ["demo", "prueba", "ver como", "ver cómo", "funcionaria", "funcionaría", "muestra"])) return "demo";
  if (hasAny(text, ["precio", "precios", "plan", "planes", "costo", "cuanto", "cuánto", "mensualidad", "setup", "pago"])) return "pricing";
  if (hasAny(text, ["asesor", "humano", "representante", "contactar", "llamar", "hablar", "persona"])) return "advisor";
  if (hasAny(text, ["automatizar", "quiero bot", "necesito bot", "whatsapp", "crm", "pedido", "pedidos", "vender", "ventas"])) return "qualify";
  return "";
}

function parseInitialIntent(text) {
  const t0 = normalizeText(text);
  if (["bot", "info", "informacion", "tienda"].includes(t0)) return "";
  const n = optionNumber(text);
  if (n === "1") return "demo";
  if (n === "2") return "pricing";
  if (n === "3") return "qualify";
  if (n === "4") return "advisor";

  return parseKeywordIntent(text);
}

function parseBusinessType(text) {
  const n = optionNumber(text);
  const map = {
    "1": "Tienda virtual",
    "2": "Belleza / cosméticos",
    "3": "Ropa / accesorios",
    "4": "Suplementos / productos naturales",
    "5": "Celulares / accesorios",
    "6": "Otro",
  };
  if (map[n]) return map[n];
  if (safeText(text).length >= 3) return safeText(text);
  return "";
}

function parseReceivesOrders(text) {
  const n = optionNumber(text);
  if (n === "1") return "Sí, todos los días";
  if (n === "2") return "Sí, pero pocos";
  if (n === "3") return "Aún no, pero quiero empezar";
  if (hasAny(text, ["todos", "diario", "diarios", "muchos"])) return "Sí, todos los días";
  if (hasAny(text, ["pocos", "a veces", "algunos"])) return "Sí, pero pocos";
  if (hasAny(text, ["aun no", "todavia no", "todavía no", "quiero empezar", "no recibo"])) return "Aún no, pero quiero empezar";
  return "";
}

function parseMessagesVolume(text) {
  const n = optionNumber(text);
  if (n === "1") return "Menos de 10";
  if (n === "2") return "Entre 10 y 30";
  if (n === "3") return "Más de 30";
  if (n === "4") return "No estoy seguro/a";

  const t = normalizeText(text);
  const nums = t.match(/\d+/g)?.map(Number) || [];
  const max = nums.length ? Math.max(...nums) : null;
  if (max !== null) {
    if (max < 10) return "Menos de 10";
    if (max <= 30) return "Entre 10 y 30";
    return "Más de 30";
  }
  if (hasAny(text, ["no se", "no sé", "no estoy seguro", "no estoy segura"])) return "No estoy seguro/a";
  return "";
}

function parseCatalog(text) {
  const n = optionNumber(text);
  if (n === "1") return "Sí";
  if (n === "2") return "No todavía";
  if (n === "3") return "Lo manejo por fotos / Instagram";
  if (hasAny(text, ["si", "sí", "catalogo", "catálogo", "lista", "menu", "menú", "precio"])) return "Sí";
  if (hasAny(text, ["no", "todavia", "todavía"])) return "No todavía";
  if (hasAny(text, ["foto", "fotos", "instagram", "ig", "redes"])) return "Lo manejo por fotos / Instagram";
  return "";
}

function parseProductsCount(text) {
  const n = optionNumber(text);
  if (n === "1") return "Hasta 20 productos";
  if (n === "2") return "Hasta 60 productos";
  if (n === "3") return "Más de 60 productos";
  if (n === "4") return "No estoy seguro/a";

  const nums = normalizeText(text).match(/\d+/g)?.map(Number) || [];
  const max = nums.length ? Math.max(...nums) : null;
  if (max !== null) {
    if (max <= 20) return "Hasta 20 productos";
    if (max <= 60) return "Hasta 60 productos";
    return "Más de 60 productos";
  }
  if (hasAny(text, ["no se", "no sé", "no estoy seguro", "no estoy segura"])) return "No estoy seguro/a";
  return "";
}

function parseNeeds(text) {
  const t = normalizeText(text);
  const nums = [...t.matchAll(/\b([1-6])\b/g)].map((m) => m[1]);
  const map = {
    "1": "Responder preguntas frecuentes",
    "2": "Tomar pedidos",
    "3": "Pedir dirección y método de pago",
    "4": "Recibir comprobantes",
    "5": "Organizar clientes en CRM",
    "6": "Dar seguimiento a interesados",
  };
  const selected = nums.map((x) => map[x]).filter(Boolean);

  if (hasAny(text, ["pregunta", "faq", "frecuente", "responder"])) selected.push(map["1"]);
  if (hasAny(text, ["pedido", "orden", "venta", "comprar"])) selected.push(map["2"]);
  if (hasAny(text, ["direccion", "dirección", "pago", "metodo", "método", "delivery"])) selected.push(map["3"]);
  if (hasAny(text, ["comprobante", "transferencia", "recibo"])) selected.push(map["4"]);
  if (hasAny(text, ["crm", "organizar", "cliente", "panel"])) selected.push(map["5"]);
  if (hasAny(text, ["seguimiento", "interesado", "recordatorio", "incompleto"])) selected.push(map["6"]);

  const unique = [...new Set(selected)];
  if (unique.length) return unique;
  if (safeText(text).length >= 3 && !isGreetingOnly(text)) return [safeText(text)];
  return [];
}

function parseContactPreference(text) {
  const n = optionNumber(text);
  if (n === "1") return "Agendar llamada";
  if (n === "2") return "Que me escriban por WhatsApp";
  if (hasAny(text, ["llamada", "agendar", "reunion", "reunión", "zoom", "meet"])) return "Agendar llamada";
  if (hasAny(text, ["whatsapp", "escriban", "mensaje", "por aqui", "por aquí"])) return "Que me escriban por WhatsApp";
  return "";
}

function suggestPlan(mem) {
  const volume = mem.messages_volume;
  const count = mem.products_count;
  const needs = (mem.needs || []).join(" ").toLowerCase();

  if (volume === "Más de 30" || count === "Más de 60 productos" || needs.includes("crm") || needs.includes("seguimiento")) {
    return "Tienda Start o Tienda Elite";
  }
  if (volume === "Entre 10 y 30" || count === "Hasta 60 productos") return "Tienda Start";
  return "Tienda Basic";
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
    intent: mem.intent,
    business_type: mem.business_type,
    receives_orders: mem.receives_orders,
    messages_volume: mem.messages_volume,
    business_name: mem.business_name,
    business_main: mem.business_main,
    has_catalog: mem.has_catalog,
    products_count: mem.products_count,
    needs: mem.needs,
    contact_name: mem.contact_name,
    contact_preference: mem.contact_preference,
    plan_suggested: mem.plan_suggested,
    status: mem.status,
    human_handoff: mem.human_handoff,
  };
}

function handleConversation(mem, userText) {
  const text = safeText(userText);
  const normalized = normalizeText(text);

  if (hasAny(text, ["reiniciar", "empezar de nuevo", "inicio", "menu", "menú"])) {
    const fresh = resetMemoryKeepHistory(mem);
    return { mem: fresh, reply: introReply() };
  }

  if (mem.cierre_enviado || mem.pending === "closed") {
    if (isAck(text) || isGreetingOnly(text)) return { mem, reply: closedReply() };
    return { mem, reply: "Ya tu solicitud quedó registrada 🙌 Un asesor te escribirá en breve. Si quieres iniciar otra consulta, escribe MENÚ." };
  }

  // Atajos globales útiles para campaña
  const globalIntent = parseKeywordIntent(text);
  if (["pricing", "demo", "advisor"].includes(globalIntent) && !["intent", "business_name", "business_main", "contact_name", "advisor_business_name"].includes(mem.pending)) {
    mem.intent = globalIntent;
    if (globalIntent === "pricing") {
      mem.pending = "messages_volume";
      return { mem, reply: askMessagesVolume() };
    }
    if (globalIntent === "demo") {
      mem.pending = "business_type";
      return { mem, reply: askBusinessType() };
    }
    if (globalIntent === "advisor") {
      mem.pending = "contact_name";
      return { mem, reply: askContactName() };
    }
  }

  switch (mem.pending) {
    case "intent": {
      const intent = parseInitialIntent(text);
      if (!intent || isGreetingOnly(text)) return { mem, reply: introReply() };
      mem.intent = intent;
      if (intent === "demo") {
        mem.pending = "business_type";
        return { mem, reply: askBusinessType() };
      }
      if (intent === "pricing") {
        mem.pending = "messages_volume";
        return { mem, reply: askMessagesVolume() };
      }
      if (intent === "qualify") {
        mem.pending = "business_name";
        return { mem, reply: askBusinessName() };
      }
      mem.pending = "contact_name";
      return { mem, reply: askContactName() };
    }

    case "business_type": {
      const value = parseBusinessType(text);
      if (!value) return { mem, reply: "¿Me indicas el tipo de negocio? Puedes responder con el número o escribirlo en una línea 😊" };
      mem.business_type = value;
      mem.pending = "receives_orders";
      return { mem, reply: askReceivesOrders() };
    }

    case "receives_orders": {
      const value = parseReceivesOrders(text);
      if (!value) return { mem, reply: "¿Actualmente recibes pedidos por WhatsApp? Responde 1, 2 o 3 para orientarte mejor 😊" };
      mem.receives_orders = value;
      mem.demo_sent = true;
      mem.status = "demo_enviada";
      mem.pending = "after_demo";
      return { mem, reply: demoReply() };
    }

    case "after_demo": {
      const n = optionNumber(text);
      if (n === "1" || hasAny(text, ["si", "sí", "asesor", "explicar", "recomienda", "recomendar"])) {
        mem.pending = "business_name";
        return { mem, reply: askBusinessName() };
      }
      if (n === "2" || hasAny(text, ["planes", "precio", "precios", "ver plan"])) {
        mem.pending = "messages_volume";
        return { mem, reply: askMessagesVolume() };
      }
      return { mem, reply: "¿Quieres que un asesor te explique cuál plan te conviene o prefieres ver los planes primero?\n\n1️⃣ Sí, quiero asesoría\n2️⃣ Ver planes primero" };
    }

    case "messages_volume": {
      const value = parseMessagesVolume(text);
      if (!value) return { mem, reply: "¿Cuántos mensajes recibes aproximadamente al día? Puedes responder 1, 2, 3 o 4 😊" };
      mem.messages_volume = value;
      mem.status = "planes_enviados";
      mem.pending = "after_pricing";
      return { mem, reply: pricingReply() };
    }

    case "after_pricing": {
      const n = optionNumber(text);
      if (n === "1" || hasAny(text, ["recomienda", "recomendar", "ideal", "cual", "cuál"])) {
        mem.pending = "business_name";
        return { mem, reply: askBusinessName() };
      }
      if (n === "2" || hasAny(text, ["demo", "ver", "probar"])) {
        mem.pending = "business_type";
        return { mem, reply: askBusinessType() };
      }
      if (n === "3" || hasAny(text, ["asesor", "humano", "representante", "hablar"])) {
        mem.pending = "contact_name";
        return { mem, reply: askContactName() };
      }
      return { mem, reply: "¿Qué deseas hacer ahora?\n1️⃣ Recomiéndame un plan\n2️⃣ Quiero una demo\n3️⃣ Hablar con asesor" };
    }

    case "business_name": {
      if (isNoise(text) || isGreetingOnly(text)) return { mem, reply: "¿Cuál es el nombre de tu negocio? 😊" };
      mem.business_name = text;
      mem.pending = "business_main";
      return { mem, reply: askBusinessMain() };
    }

    case "business_main": {
      if (isNoise(text) || isGreetingOnly(text)) return { mem, reply: "¿Qué vendes principalmente? Ejemplo: ropa, cosméticos, celulares, accesorios, suplementos, etc." };
      mem.business_main = text;
      mem.pending = "has_catalog";
      return { mem, reply: askCatalog() };
    }

    case "has_catalog": {
      const value = parseCatalog(text);
      if (!value) return { mem, reply: "¿Tienes catálogo, lista de productos o menú de precios?\n\n1️⃣ Sí\n2️⃣ No todavía\n3️⃣ Lo manejo por fotos / Instagram" };
      mem.has_catalog = value;
      mem.pending = "products_count";
      return { mem, reply: askProductsCount() };
    }

    case "products_count": {
      const value = parseProductsCount(text);
      if (!value) return { mem, reply: "¿Cuántos productos te gustaría automatizar al inicio? Responde 1, 2, 3 o 4 😊" };
      mem.products_count = value;
      mem.pending = "needs";
      return { mem, reply: askNeeds() };
    }

    case "needs": {
      const needs = parseNeeds(text);
      if (!needs.length) return { mem, reply: askNeeds() };
      mem.needs = needs;
      mem.pending = "contact_preference";
      return { mem, reply: askContactPreference() };
    }

    case "contact_preference": {
      const value = parseContactPreference(text);
      if (!value) return { mem, reply: "¿Prefieres agendar una llamada o que un asesor te escriba por WhatsApp?\n\n1️⃣ Agendar llamada\n2️⃣ Que me escriban por WhatsApp" };
      mem.contact_preference = value;
      return { mem, reply: finalLeadReply(mem) };
    }

    case "contact_name": {
      if (isNoise(text) || isGreetingOnly(text)) return { mem, reply: "¿Me indicas tu nombre para pasarte con un asesor? 😊" };
      mem.contact_name = text;
      mem.pending = "advisor_business_name";
      return { mem, reply: "Gracias. ¿Cuál es el nombre de tu negocio o proyecto?" };
    }

    case "advisor_business_name": {
      if (!isNoise(text) && !isGreetingOnly(text)) mem.business_name = text;
      return { mem, reply: advisorFinalReply(mem) };
    }

    default:
      mem.pending = "intent";
      return { mem, reply: introReply() };
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
    const reply = safeText(result.reply) || introReply();

    rememberHistory(mem, userText, reply);
    await saveMemory(contactId, mem);

    console.log("[/mc/reply] state:", JSON.stringify(appendLeadSummary(mem)));
    console.log("[/mc/reply] done in", Date.now() - started, "ms");

    return res.json({ reply });
  } catch (err) {
    console.error("[/mc/reply] ERROR:", err?.stack || err);
    return res.json({ reply: "Se me complicó un momentito 😅 ¿Me lo mandas de nuevo en una línea?" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log("running on", PORT));
