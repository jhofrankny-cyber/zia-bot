const express = require("express");
const Redis = require("ioredis");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ENV
const PORT = process.env.PORT || 3000;
const MC_AUTH_TOKEN = process.env.MC_AUTH_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cambia si quieres

// Redis (recomendado)
const redisUrl = process.env.REDIS_URL; // ej: rediss://:pass@host:port
const redis = redisUrl ? new Redis(redisUrl) : null;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function mustAuth(req) {
  if (!MC_AUTH_TOKEN) return true;
  return req.headers.authorization === `Bearer ${MC_AUTH_TOKEN}`;
}

function safeText(x) {
  return String(x || "").trim();
}

function defaultMemory() {
  return {
    // estado mínimo (para tu lógica)
    rubro: "",
    servicio: "",
    redes: "",
    objetivo: "",
    cerrado: false,
    cierre_enviado: false,

    // historial reducido (para contexto del tono)
    history: [] // [{role:"user"/"assistant", content:"..."}]
  };
}

async function loadMemory(contactId) {
  if (!redis) return defaultMemory(); // sin redis, no persistente (solo demo)
  const key = `zia:${contactId}`;
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : defaultMemory();
}

async function saveMemory(contactId, mem) {
  if (!redis) return;
  const key = `zia:${contactId}`;
  // TTL 7 días (ajusta)
  await redis.set(key, JSON.stringify(mem), "EX", 60 * 60 * 24 * 7);
}

function buildSystemPrompt() {
  // Tu prompt base + reglas, pero además forzamos salida estructurada
  return `
Eres Zia Bot, el asistente comercial de Zia Lab Agency. Hablas como una persona real, cercana y profesional, con tono relajado-formal en español natural (RD si aplica).

REGLAS CLAVE
- No repitas el saludo si ya existe conversación previa.
- Mensajes cortos (máx. 2-3 líneas).
- Una sola pregunta por mensaje.
- Emojis variados y naturales (😊✨🚀🙌🧡).
- No uses etiquetas tipo “[CLIENTE]”.
- No hagas propuestas largas, diagnósticos extensos ni bullets.
- No inventes datos si el usuario no lo dijo.

CONTEXTO DE CAMPAÑA
Este número pertenece a una campaña especial con 30% de descuento durante los primeros 3 meses en los servicios contratados. Menciónalo de forma natural (ideal al confirmar pase a representante).

INFORMACIÓN MÍNIMA A OBTENER (solo esto)
1) rubro
2) servicio: redes / bot / ambos
3) redes: link o @; si no tiene, nombre del negocio
4) objetivo: ventas / leads / reservas / posicionamiento

TAREA
- Usa el estado recibido (rubro/servicio/redes/objetivo/cerrado).
- Interpreta respuestas de una palabra según la última pregunta.
- Pregunta SOLO 1 cosa siguiendo el orden rubro -> servicio -> redes -> objetivo.
- Cuando ya tengas las 4, envía el CIERRE ÚNICO.
- Si ya cerraste y el usuario dice ok/gracias/hola/mañana/perfecto/listo/👍 responde SOLO:
  “¡Listo! Ya quedó registrado 🙌 En breve te escribe un representante.”

CIERRE ÚNICO
“¡Perfecto! Entonces trabajaremos [servicio] para tu negocio enfocados en [objetivo]. 😊
Un representante de Zia Lab te estará contactando en breve para presentarte la propuesta con el 30% OFF por los primeros 3 meses 🚀”

SALIDA OBLIGATORIA:
Devuelve SOLO JSON válido (sin texto extra), con este formato:
{
  "reply": "mensaje para el usuario",
  "state": {
    "rubro": "",
    "servicio": "",
    "redes": "",
    "objetivo": "",
    "cerrado": false,
    "cierre_enviado": false
  }
}

Reglas del JSON:
- "reply" debe ser lo que se enviará al usuario.
- "state" debe venir actualizado según el último mensaje del usuario y el estado previo.
- Nunca inventes datos: si no lo dijo, déjalo igual.
`;
}

function clampHistory(history, max = 10) {
  if (!Array.isArray(history)) return [];
  return history.slice(-max);
}

app.post("/mc/reply", async (req, res) => {
  try {
    if (!mustAuth(req)) return res.status(401).json({ error: "unauthorized" });

    const contactId = safeText(req.body.contact_id);
    const userText = safeText(req.body.user_text);

    if (!contactId || !userText) {
      return res.status(400).json({ error: "missing contact_id or user_text" });
    }

    // 1) cargar memoria
    const mem = await loadMemory(contactId);

    // 2) armar mensajes para el modelo
    const sys = buildSystemPrompt();

    const stateSnapshot = {
      rubro: mem.rubro,
      servicio: mem.servicio,
      redes: mem.redes,
      objetivo: mem.objetivo,
      cerrado: !!mem.cerrado,
      cierre_enviado: !!mem.cierre_enviado
    };

    const messages = [
      { role: "system", content: sys },
      { role: "system", content: `ESTADO ACTUAL: ${JSON.stringify(stateSnapshot)}` },
      ...clampHistory(mem.history, 10),
      { role: "user", content: userText }
    ];

    // 3) llamar OpenAI
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 220
    });

    const raw = completion.choices?.[0]?.message?.content || "";

    // 4) parsear JSON
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // fallback: respuesta segura si el modelo no devolvió JSON
      return res.json({
        reply: "Se me fue la señal un momentito 😅 ¿Me repites eso en una línea, porfa?",
      });
    }

    const reply = safeText(parsed.reply);
    const newState = parsed.state || {};

    // 5) actualizar memoria (estado + historial)
    mem.rubro = safeText(newState.rubro) || mem.rubro;
    mem.servicio = safeText(newState.servicio) || mem.servicio;
    mem.redes = safeText(newState.redes) || mem.redes;
    mem.objetivo = safeText(newState.objetivo) || mem.objetivo;
    mem.cerrado = !!newState.cerrado;
    mem.cierre_enviado = !!newState.cierre_enviado;

    mem.history = clampHistory(
      [...(mem.history || []), { role: "user", content: userText }, { role: "assistant", content: reply }],
      12
    );

    await saveMemory(contactId, mem);

    return res.json({ reply });
  } catch (err) {
    console.error(err);
    return res.json({ reply: "Se me complicó un momentito 😅 ¿Me lo mandas de nuevo en una línea?" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log("running on", PORT));
