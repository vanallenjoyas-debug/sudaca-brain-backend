const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const VERSION = '1.9.0';
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/', limits: { fileSize: 100 * 1024 * 1024 } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---- AUTH ----
const APP_PASSWORD = process.env.APP_PASSWORD || 'sudaca2024';
function requireAuth(req, res, next) {
  const token = req.headers['x-app-token'];
  if (token !== APP_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ---- DB ----
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT,
      views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comment_count INTEGER DEFAULT 0,
      analysis TEXT, copy_original TEXT, comments_raw TEXT, frames_data JSONB DEFAULT '[]',
      answers JSONB DEFAULT '[]', timestamp TIMESTAMPTZ DEFAULT NOW(), status TEXT DEFAULT 'analyzed'
    );
    CREATE TABLE IF NOT EXISTS glosario (
      id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, video_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS patrones (
      id SERIAL PRIMARY KEY, patron TEXT UNIQUE NOT NULL, video_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS copy_original TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS comments_raw TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS frames_data JSONB DEFAULT '[]'`).catch(()=>{});
  await pool.query(`ALTER TABLE glosario ADD COLUMN IF NOT EXISTS video_url TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE patrones ADD COLUMN IF NOT EXISTS video_url TEXT`).catch(()=>{});
  console.log('DB ready');
}

// ---- CLAUDE ----
const callClaude = async (messages, maxTokens = 4000, model = 'claude-sonnet-4-20250514') => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
};

// ---- GEMINI ----
const callGemini = async (prompt) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY no configurada');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 2048 }
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text;
};

// ---- PUBLIC ROUTES ----
app.get('/', (req, res) => res.json({ status: 'ok', service: 'sudaca-brain', version: VERSION }));

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) res.json({ ok: true, token: APP_PASSWORD });
  else res.status(401).json({ error: 'Contraseña incorrecta' });
});

// ---- YOUTUBE PROXY ----
app.get('/yt/video/:videoId', requireAuth, async (req, res) => {
  const YT_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY no configurada' });
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${req.params.videoId}&key=${YT_KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/yt/comments/:videoId', requireAuth, async (req, res) => {
  const YT_KEY = process.env.YOUTUBE_API_KEY;
  if (!YT_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY no configurada' });
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${req.params.videoId}&order=relevance&maxResults=50&key=${YT_KEY}`);
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- ANALYZE ----
app.post('/analyze', requireAuth, upload.single('video'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  console.log(`[v${VERSION}] /analyze - file: ${req.file ? req.file.size + ' bytes' : 'NO FILE'}`);
  const { url, title, views, likes, comment_count, comments, copy_original, glosario, patrones } = req.body;
  let glosarioObj = {}, patronesArr = [];
  try { glosarioObj = JSON.parse(glosario || '{}'); } catch(e) {}
  try { patronesArr = JSON.parse(patrones || '[]'); } catch(e) {}
  const glosarioStr = Object.entries(glosarioObj).length > 0 ? 'Glosario conocido: ' + Object.entries(glosarioObj).map(([k,v]) => `"${k}" = ${v}`).join(', ') : 'Sin glosario previo.';

  const prompt = `Sos un analizador experto del creador Javier Romero "Joyería Sudaca".

CONTEXTO:
- Joyero argentino, ~105K suscriptores YouTube, ~170K seguidores totales
- Sus Shorts: sarcasmo e ironía, dice una cosa y muestra otra
- Nombres inventados para materiales (bórax = "sal del himalaya"/"lágrimas de ángel", ácido nítrico = "bebida de los pueblos nobles", lima = "supositorio del joyero") — VARÍAN, no son fijos
- Humor de taller, cuarta pared, anticlímax, resignación activa
- Frase característica: "porque esto es joyería sudaca papá"

SOBRE LA ESPONTANEIDAD — MUY IMPORTANTE:
- El 95% de lo que dice Javier es COMPLETAMENTE ESPONTÁNEO: nombres inventados, comparaciones, humor, remates
- Lo que es PREMEDITADO son las frases que se REPITEN entre videos (ej: "porque esto es joyería sudaca papá", frases del glosario conocido)
- Para identificar si algo es premeditado: buscalo en el glosario y patrones previos. Si está ahí, es recurrente y posiblemente deliberado. Si no está, es espontáneo
- NUNCA preguntes si algo fue espontáneo, planificado, premeditado, o si "tenía la idea desde antes" — la respuesta siempre es espontáneo
- NUNCA preguntes sobre el origen de un chiste, frase o comparación — todos surgen en el momento
- Solo preguntá sobre HECHOS VERIFICABLES que no podés saber: qué químico usó exactamente, si un accidente fue real, qué objeto es el que aparece en pantalla

${glosarioStr}
Patrones previos: ${patronesArr.join(', ') || 'ninguno aún'}

VIDEO: URL: ${url} | Título: ${title}
Views: ${views || '?'} | Likes: ${likes || '?'}

COPY ORIGINAL DEL VIDEO:
${copy_original || 'No proporcionado — inferir del análisis visual'}

COMENTARIOS:
${comments || 'No proporcionados'}

ANALIZÁ CON MÁXIMO DETALLE:

## ANÁLISIS VISUAL
Frame a frame: materiales, herramientas, procesos, acciones, ambiente del taller.

## ANÁLISIS DEL DISCURSO
${copy_original ? 'Con el copy original disponible, analizá cada frase: tono, ritmo, énfasis, intención.' : 'Inferí el discurso desde los frames. Transcribí lo más posible.'}

## CRUCES VISUAL/VERBAL (CRÍTICO)
Cada contradicción, ironía o humor entre lo que se ve y lo que se dice. Explicá el mecanismo exacto del chiste.

## ESTRUCTURA NARRATIVA
- GANCHO (primeros 3 segundos)
- DESARROLLO
- REMATE

## ANÁLISIS DE COMENTARIOS
Qué resonó, PEDIDOS DE CONTENIDO específicos.

## GLOSARIO DETECTADO
Formato: TÉRMINO_USADO → qué es realmente

## PATRONES REPLICABLES
Recursos con potencial de replicarse y por qué funcionaron.

## PREGUNTAS PARA JAVIER
TU OBJETIVO ES GENERAR GUIONES Y COPYS para Javier, no aprender joyería ni química.
Por lo tanto las preguntas deben ser SOLO sobre comunicación, narrativa y humor — nunca sobre técnica de taller.

PREGUNTAS PERMITIDAS (ejemplos):
- Qué nombre usó para X en el video (si no está claro en el copy)
- Si un accidente visible fue real o actuado
- Qué objeto específico aparece en pantalla y no se menciona

PREGUNTAS PROHIBIDAS:
- Cualquier pregunta sobre procesos químicos o técnicos de joyería
- Cualquier pregunta sobre cantidades, tiempos, materiales exactos
- Cualquier pregunta sobre si algo fue espontáneo o planificado
- Cualquier pregunta cuya respuesta no impacte directamente en cómo escribir un guión

Antes de hacer cada pregunta preguntate: ¿saber esto me ayuda a escribir un guión mejor? Si la respuesta es no, no preguntes.
Si no hay preguntas realmente útiles para el guión, no hagas ninguna.
Formato: PREGUNTA_N: [pregunta concreta]

Sé exhaustivo. El video se descarta tras este análisis.`;

  try {
    let frameImages = [];
    if (req.file) {
      const ts = Date.now();
      const framesDir = `/tmp/frames_${ts}`;
      fs.mkdirSync(framesDir, { recursive: true });
      try {
        execSync(`ffmpeg -i "${req.file.path}" -vf "fps=1,scale=480:-1" -frames:v 60 "${framesDir}/frame_%03d.jpg" -y 2>/dev/null`);
        const ff = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        console.log(`Extracted ${ff.length} frames at 1fps`);
        frameImages = ff.map(f => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(framesDir, f)).toString('base64') } }));
        ff.forEach(f => fs.unlinkSync(path.join(framesDir, f)));
        fs.rmdirSync(framesDir);
      } catch(e) { console.log('ffmpeg frames error:', e.message); }
      fs.unlinkSync(req.file.path);
    }

    const messages = [{ role: 'user', content: frameImages.length > 0
      ? [{ type: 'text', text: `${frameImages.length} frames del video (1 por segundo):\n\n${prompt}` }, ...frameImages]
      : prompt
    }];

    const analysis = await callClaude(messages, 4000);
    res.json({ analysis, frames_data: frameImages.map(f => f.source.data) });
  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

// ---- REFINE ----
app.post('/refine', requireAuth, async (req, res) => {
  const { analysis, answers } = req.body;
  try {
    const refined = await callClaude([{ role: 'user', content: `Análisis de video de Joyería Sudaca:\n\n${analysis}\n\nJavier respondió:\n${answers.map(a=>`P: ${a.question}\nR: ${a.answer}`).join('\n\n')}\n\nActualizá solo GLOSARIO DETECTADO y PATRONES REPLICABLES.` }], 1000);
    res.json({ refined });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE COPY (Gemini) ----
app.post('/generate', requireAuth, async (req, res) => {
  const { description, glosario, patrones, contextVideos } = req.body;
  try {
    const copysReales = (contextVideos||[]).filter(v=>v.copy_original).slice(-8)
      .map(v=>`[${parseInt(v.views)?.toLocaleString()||'?'} views] ${v.title||''}:
${v.copy_original}`).join('
---
');
    const glosarioStr = Object.entries(glosario||{}).slice(0,10).map(([k,v])=>`"${k}" = ${v}`).join(', ');
    const prompt = `Sos el asistente creativo de Javier Romero, joyero argentino "Joyería Sudaca" (~170K seguidores). Escribís guiones para sus Shorts de 30-45 segundos (60-90 palabras máximo).

CÓMO HABLA JAVIER — leé sus guiones reales y aprendé su voz:
${copysReales || 'Sin copys disponibles'}

SU LÓGICA:
- Habla como un joyero cansado con humor seco y resignación activa
- Anticlímax: expectativa → remate mundano o personal
- Frases cortas, ritmo irregular, como si pensara en voz alta
- Expertise real disfrazado de ignorancia o desinterés
- Inventa nombres domésticos para cosas técnicas (referencia del glosario: ${glosarioStr||'en construcción'})
- NO copiar sus frases existentes — inventá frases nuevas con la misma lógica
- NO metáforas elaboradas, NO sonar a marketing

VIDEO A GUIONAR: ${description}

Generá 3 opciones con enfoques completamente distintos. Máximo 90 palabras cada una. Separalas con "---". Solo el guión, sin etiquetas ni explicaciones extra.`;
    const copy = await callGemini(prompt);
    res.json({ copy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE SIMPLE (Gemini) ----
app.post('/generate-simple', requireAuth, async (req, res) => {
  const { description, glosario, patrones, contextVideos } = req.body;
  try {
    const copysReales = (contextVideos||[]).filter(v=>v.copy_original).slice(-5)
      .map(v=>`${v.copy_original}`).join('
---
');
    const prompt = `Sos el asistente creativo de Javier Romero, joyero argentino "Joyería Sudaca".

Sus guiones reales (aprendé su voz):
${copysReales || 'Sin copys disponibles'}

VIDEO: ${description}

3 opciones de guión, 60-90 palabras cada una, estilo de Javier. Separalas con "---".`;
    const copy = await callGemini(prompt);
    res.json({ copy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


