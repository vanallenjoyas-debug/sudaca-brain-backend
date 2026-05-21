const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const VERSION = '2.0.5';
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
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 2048 } })
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
    const copysReales = (contextVideos||[]).filter(v=>v.copy_original).slice(-8).map(v=>`[${parseInt(v.views)?.toLocaleString()||'?'} views] ${v.title||''}:\n${v.copy_original}`).join('\n---\n');
    const glosarioStr = Object.entries(glosario||{}).slice(0,10).map(([k,v])=>`"${k}" = ${v}`).join(', ');
    const prompt = `Sos el asistente creativo de Javier Romero, joyero argentino "Joyería Sudaca" (~170K seguidores). Escribís guiones para sus Shorts de 30-45 segundos (60-90 palabras máximo).\n\nCÓMO HABLA JAVIER — leé sus guiones reales y aprendé su voz:\n${copysReales || 'Sin copys disponibles'}\n\nSU LÓGICA:\n- Habla como un joyero cansado con humor seco y resignación activa\n- Anticlímax: expectativa → remate mundano o personal\n- Frases cortas, ritmo irregular, como si pensara en voz alta\n- Expertise real disfrazado de ignorancia o desinterés\n- Inventa nombres domésticos para cosas técnicas (referencia del glosario: ${glosarioStr||'en construcción'})\n- NO copiar sus frases — inventá nuevas con la misma lógica\n- NO metáforas elaboradas, NO sonar a marketing\n\nVIDEO A GUIONAR: ${description}\n\nGenerá 3 opciones con enfoques distintos. Máximo 90 palabras cada una. Separalas con "---". Solo el guión.`;
    const copy = await callGemini(prompt);
    res.json({ copy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE SIMPLE ----
app.post('/generate-simple', requireAuth, async (req, res) => {
  const { description, glosario, patrones, contextVideos } = req.body;
  try {
    const copysReales = (contextVideos||[]).filter(v=>v.copy_original).slice(-8).map(v=>`[${parseInt(v.views)?.toLocaleString()||'?'} views]\n${v.copy_original}`).join('\n---\n');
    const glosarioStr = Object.entries(glosario||{}).slice(0,10).map(([k,v])=>`"${k}" = ${v}`).join(', ');

    const prompt = `Sos el asistente creativo de Javier Romero, joyero argentino "Joyería Sudaca" (~170K seguidores). Escribís guiones para sus Shorts de 30-45 segundos (60-90 palabras máximo).

CÓMO HABLA JAVIER — leé estos guiones reales suyos y aprendé su voz:
${copysReales || 'Sin copys disponibles aún'}

SU LÓGICA:
- Habla como un joyero cansado con humor seco
- Resignación activa: acepta lo malo como si fuera normal
- Anticlímax: expectativa → remate mundano o personal
- Frases cortas, ritmo irregular, piensa en voz alta
- Expertise real disfrazado de ignorancia o desinterés
- Inventa nombres domésticos para cosas técnicas (ejemplos del glosario: ${glosarioStr||'en construcción'})
- NO metáforas elaboradas, NO sonar a marketing

VIDEO A GUIONAR: ${description}

Generá 3 opciones de guión con enfoques distintos. Máximo 90 palabras cada uno. Sin etiquetas ni explicaciones — solo el guión.`;

    const copy = await callGemini(prompt);
    res.json({ copy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/generate-with-video', requireAuth, upload.single('video'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  const { glosario, patrones, contextVideos } = req.body;
  let glosarioObj = {}, patronesArr = [], contextArr = [];
  try { glosarioObj = JSON.parse(glosario || '{}'); } catch(e) {}
  try { patronesArr = JSON.parse(patrones || '[]'); } catch(e) {}
  try { contextArr = JSON.parse(contextVideos || '[]'); } catch(e) {}

  let frameImages = [];
  if (req.file) {
    const framesDir = `/tmp/frames_gen_${Date.now()}`;
    fs.mkdirSync(framesDir, { recursive: true });
    try {
      execSync(`ffmpeg -i "${req.file.path}" -vf "fps=1,scale=480:-1" -frames:v 60 "${framesDir}/frame_%03d.jpg" -y 2>/dev/null`);
      const ff = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      frameImages = ff.map(f => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(framesDir, f)).toString('base64') } }));
      ff.forEach(f => fs.unlinkSync(path.join(framesDir, f)));
      fs.rmdirSync(framesDir);
    } catch(e) { console.log('ffmpeg error:', e.message); }
    fs.unlinkSync(req.file.path);
  }

  const prevFrameImages = [];
  for (const v of contextArr.slice(0, 3)) {
    if (v.frames_data?.length > 0) {
      const frames = v.frames_data;
      [0, Math.floor(frames.length/2), frames.length-1].filter(i => i < frames.length).forEach(i =>
        prevFrameImages.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frames[i] } })
      );
    }
  }

  const prompt = `Sos el asistente creativo de Javier "Joyería Sudaca" Romero.

Tu objetivo es generar guiones en su estilo, no repetir lo que ya hizo.

CÓMO USAR EL GLOSARIO Y PATRONES:
- El glosario muestra su LÓGICA CREATIVA — usala para inventar nombres NUEVOS para lo que ves en los frames
- A veces repetir un nombre del glosario funciona, a veces inventar uno nuevo, a veces usar el nombre técnico real. Es orgánico
- Los patrones son MECANISMOS — aplicá el mecanismo, no la frase

Glosario (lógica creativa, no copiar): ${Object.entries(glosarioObj).map(([k,v])=>`"${k}"=${v}`).join(', ')||'En construcción'}
Patrones: ${patronesArr.join(' | ')||'En construcción'}
Videos previos (referencia de estilo): ${contextArr.slice(0,4).map(v=>`[${parseInt(v.views)?.toLocaleString()} views] ${(v.analysis||'').substring(0,500)}`).join('\n---\n')}

${frameImages.length > 0 ? `Te mando ${frameImages.length} frames del video nuevo (1 por segundo). Basate en lo que VES para hacer el copy específico.` : 'No se pudo procesar el video.'}
${prevFrameImages.length > 0 ? 'También frames de videos anteriores para entender el estilo visual.' : ''}

LONGITUD CRÍTICA: Los videos de Javier duran 30-45 segundos. El copy tiene que ser de 80-120 palabras máximo. Contá las palabras antes de entregar. Si superás 120 palabras, recortá.

GENERÁ 3 OPCIONES DE COPY completamente distintas:
OPCIÓN_N: [nombre del enfoque]
PATRÓN USADO: [mecanismo narrativo]
COPY COMPLETO: [guión listo para usar, en voz de Javier — MÁXIMO 120 PALABRAS]
NOMBRES NUEVOS: [nombres inventados para los materiales si aplica]`;

  try {
    const content = [{ type: 'text', text: prompt }, ...frameImages];
    if (prevFrameImages.length > 0) content.push({ type: 'text', text: 'Frames de videos anteriores:' }, ...prevFrameImages);
    const copy = await callClaude([{ role: 'user', content }], 2000, 'claude-opus-4-5');
    res.json({ copy });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ---- IDEAS ----
app.post('/ideas', requireAuth, async (req, res) => {
  const { videos } = req.body;
  if (!videos?.length) return res.status(400).json({ error: 'No hay videos' });
  try {
    const ideas = await callClaude([{ role: 'user', content: `Sos el estratega de contenido de Javier "Joyería Sudaca".

COMENTARIOS:
${videos.map(v=>`VIDEO: ${v.title}\n${v.comments_raw||''}`).join('\n\n---\n\n')}

ANÁLISIS PREVIOS:
${videos.map(v=>v.analysis||'').join('\n\n---\n\n').substring(0,3000)}

GENERÁ:
## PEDIDOS RECURRENTES DE LA AUDIENCIA
## IDEAS DE CONTENIDO BASADAS EN COMENTARIOS (10 ideas con IDEA, BASADA EN, GANCHO SUGERIDO, POTENCIAL)
## TEMAS QUE LA AUDIENCIA QUIERE VER MÁS
## FORMATOS QUE GENERAN MÁS REACCIÓN` }], 3000);
    res.json({ ideas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- VIDEOS ----
app.get('/videos', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM videos ORDER BY views DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/videos', requireAuth, async (req, res) => {
  const { url, title, views, likes, comment_count, analysis, copy_original, comments_raw, answers } = req.body;
  let frames_data = req.body.frames_data;
  // Normalize frames_data to valid JSON string
  if (!frames_data) frames_data = '[]';
  else if (Array.isArray(frames_data)) frames_data = JSON.stringify(frames_data);
  else if (typeof frames_data === 'string') {
    try { JSON.parse(frames_data); } catch(e) { frames_data = '[]'; }
  }
  try {
    const r = await pool.query(`INSERT INTO videos (url,title,views,likes,comment_count,analysis,copy_original,comments_raw,frames_data,answers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title,views=EXCLUDED.views,likes=EXCLUDED.likes,comment_count=EXCLUDED.comment_count,analysis=EXCLUDED.analysis,copy_original=EXCLUDED.copy_original,comments_raw=EXCLUDED.comments_raw,frames_data=EXCLUDED.frames_data,answers=EXCLUDED.answers,timestamp=NOW() RETURNING *`,
      [url,title,views,likes,comment_count,analysis,copy_original,comments_raw,frames_data,JSON.stringify(answers||[])]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/videos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM videos WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GLOSARIO ----
app.get('/glosario', requireAuth, async (req, res) => {
  try { const r=await pool.query('SELECT * FROM glosario ORDER BY created_at ASC'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/glosario', requireAuth, async (req, res) => {
  const { key, value, video_url } = req.body;
  try { await pool.query(`INSERT INTO glosario (key,value,video_url) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,[key,value,video_url||null]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/glosario/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM glosario WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/patrones/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM patrones WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PATRONES ----
app.get('/patrones', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM patrones ORDER BY created_at ASC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/patrones', requireAuth, async (req, res) => {
  const { patron, video_url } = req.body;
  try { await pool.query(`INSERT INTO patrones (patron,video_url) VALUES ($1,$2) ON CONFLICT (patron) DO NOTHING`,[patron,video_url||null]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- STATS ----
app.get('/stats', requireAuth, async (req, res) => {
  try {
    const [v,g,p] = await Promise.all([pool.query('SELECT COUNT(*) FROM videos'),pool.query('SELECT COUNT(*) FROM glosario'),pool.query('SELECT COUNT(*) FROM patrones')]);
    res.json({ videos:parseInt(v.rows[0].count), glosario:parseInt(g.rows[0].count), patrones:parseInt(p.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => app.listen(PORT, () => console.log(`Sudaca Brain v${VERSION} running on port ${PORT}`)));
