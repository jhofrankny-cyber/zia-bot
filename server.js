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

// ✅ NUEVO: ManyChat Admin Notify (Opción A)
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY || "";
const ADMIN_SUBSCRIBER_ID = process.env.ADMIN_SUBSCRIBER_ID || "";
const MANYCHAT_API_BASE = process.env.MANYCHAT_API_BASE || "https://api.manychat.com";

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

  const a2 = body.message?.attachments?.[0]?.url || body.message?.attachments?.[0]?.payload?.url;
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

function toDigits(x) {
  return safeText(x).replace(/[^\d]/g, "");
}

function buildLeadSummary({ contactId, sector, servicio, redes }) {
  const waDigits = toDigits(contactId);
  const waLink = waDigits ? `https://wa.me/${waDigits}` : "";

  return (
    `🆕 Nuevo lead (Zia Bot)\n` +
    `📌 Negocio: ${safeText(sector) || "-"}\n` +
    `🤖 Automatizar: ${safeText(servicio) || "-"}\n` +
    `📅 Citas/semana: ${safeText(redes) || "-"}\n` +
    `👤 WhatsApp: ${waDigits || safeText(contactId) || "-"}\n` +
    (waLink ? `🔗 ${waLink}\n` : "") +
    `🕒 ${new Date().toLocaleString()}`
  );
}

// ⚠️ Endpoint típico de ManyChat para WhatsApp (si tu cuenta lo tiene habilitado)
// Si te diera 404, te digo en 1 mensaje cuál endpoint alterno cambiar.
async function sendAdminWhatsAppViaManyChat(text) {
  const url = `${MANYCHAT_API_BASE}/whatsapp/sending/sendText`;

  await axios.post(
    url,
    {
      subscriber_id: Number(ADMIN_SUBSCRIBER_ID),
      message: safeText(text),
    },
    {
      headers: {
        Authorization: `Bearer ${MANYCHAT_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
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

    // ✅ NUEVO: evitar enviar el aviso 2 veces
    admin_notified: false,
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

  return mem;
}

async function saveMemory(contactId, mem) {
  if (!redis) return;
  const key = `zia:${contactId}`;
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

3) (redes) Volumen semanal (citas por semana):
“Aprox. ¿cuántas citas manejan por semana? Ejemplos: 5, 15, 30, 60+.”

REGLAS IMPORTANTES
- Si el usuario responde varias cosas en un mismo mensaje (incluyendo audio transcrito), extrae y guarda TODO lo que puedas para: sector, servicio y redes.
- Si ya tienes las 3 respuestas, NO preguntes más: cierra.
- En "redes" acepta números cortos: "5", "15", "30", "60+".

TAREA
- Usa el estado recibido (sector/servicio/redes/objetivo/cerrado/cierre_enviado/pending).
- Pregunta SOLO 1 cosa siguiendo el orden sector -> servicio -> redes.
- Cuando ya tengas las 3, responde EXACTO:
  “¡Listo! Ya quedó registrado 🙌 te escribe un representante.”
  y marca cerrado=true, cierre_enviado=true y objetivo="calificado".

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

    // Si ya cerró y el usuario escribe ack -> respuesta corta
    if (mem.cierre_enviado && isAck(userText)) {
      return res.json({ reply: "¡Listo! Ya quedó registrado 🙌 En breve te escribe un representante." });
    }

    // ✅ aceptar nombres raros en paso "redes"
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

    // ✅ si viene roto, reintenta 1 vez “reparando” JSON
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

    // ✅ NUEVO: cuando el lead está completo y ya cerró -> avisar a tu WhatsApp via ManyChat (1 vez)
    const leadComplete = !!(mem.sector && mem.servicio && mem.redes && mem.cierre_enviado);
    if (leadComplete && !mem.admin_notified) {
      mem.admin_notified = true;
      await saveMemory(contactId, mem);

      if (canNotifyAdminViaManyChat()) {
        const summary = buildLeadSummary({
          contactId,
          sector: mem.sector,
          servicio: mem.servicio,
          redes: mem.redes,
        });

        try {
          await sendAdminWhatsAppViaManyChat(summary);
          console.log("[admin_notify] sent ✅");
        } catch (e) {
          console.error("[admin_notify] FAILED:", e?.response?.status, e?.response?.data || e?.message || e);
        }
      } else {
        console.log("[admin_notify] skipped (missing MANYCHAT_API_KEY/ADMIN_SUBSCRIBER_ID)");
      }
    }

    console.log("[/mc/reply] done in", Date.now() - started, "ms");
    return res.json({ reply });
  } catch (err) {
    console.error("[/mc/reply] ERROR:", err?.stack || err);
    return res.json({ reply: "Se me complicó un momentito 😅 ¿Me lo mandas de nuevo en una línea?" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log("running on", PORT));
