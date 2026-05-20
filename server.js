const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const VERSION = '1.7.0';
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/', limits: { fileSize: 100 * 1024 * 1024 } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
      id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS patrones (
      id SERIAL PRIMARY KEY, patron TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS copy_original TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS comments_raw TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS frames_data JSONB DEFAULT '[]'`).catch(()=>{});
  console.log('DB ready');
}

// ---- CLAUDE ----
const callClaude = async (messages, maxTokens = 4000) => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
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
Solo preguntas genuinamente importantes.
Formato: PREGUNTA_N: [pregunta concreta]

S  exhaustivo. El video se descarta tras este análisis.`;

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

// ---- GENERATE COPY ----
app.post('/generate', requireAuth, async (req, res) => {
  const { description, momento, tono, glosario, patrones, contextVideos } = req.body;
  try {
    const copy = await callClaude([{ role: 'user', content: `Sos el asistente creativo de Javier "Joyería Sudaca" Romero.

Glosario: ${Object.entries(glosario||{}).map(([k,v])=>`"${k}"=${v}`).join(', ')||'En construcción'}
Patrones probados: ${(patrones||[]).join(' | ')||'En construcción'}
Videos previos: ${(contextVideos||[]).slice(-4).map(v=>`[${parseInt(v.views)?.toLocaleString()} views] ${(v.analysis||'').substring(0,600)}`).join('\n---\n')}

NUEVO VIDEO: ${description}
Momento: ${momento}, Tono: ${tono}

GENERÁ 3 OPCIONES DE COPY:
OPCIÓN_N: [nombre], PATRÓN USADO: [mecanismo], COPY COMPLETO: [guión], NOMBRES SUGERIDOS: [variantes nuevas]
NO repetir frases exactas. Replicar el MECANISMO.` }], 2000);
    res.json({ copy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE WITH VIDEO ----
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

Glosario: ${Object.entries(glosarioObj).map(([k,v])=>`"${k}"=${v}`).join(', ')||'En construcción'}
Patrones probados: ${patronesArr.join(' | ')||'En construcción'}
Videos previos: ${contextArr.slice(0,4).map(v=>`[${parseInt(v.views)?.toLocaleString()} views] ${(v.analysis||'').substring(0,500)}`).join('\n---\n')}

${frameImages.length > 0 ? `Te mando ${frameImages.length} frames del video nuevo (1 por segundo).` : 'No se pudo procesar el video.'}
${prevFrameImages.length > 0 ? 'También frames de videos anteriores para contexto visual.' : ''}

GENERÁ 3 OPCIONES DE COPY basadas en lo que VES en los frames:
OPCIÓN_N: [nombre], PATRÓN USADO: [mecanismo], COPY COMPLETO: [guión específico], NOMBRES SUGERIDOS: [nombres nuevos para lo que aparece]`;

  try {
    const content = [{ type: 'text', text: prompt }, ...frameImages];
    if (prevFrameImages.length > 0) content.push({ type: 'text', text: 'Frames de videos anteriores:' }, ...prevFrameImages);
    const copy = await callClaude([{ role: 'user', content }], 2000);
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
  const { url, title, views, likes, comment_count, analysis, copy_original, comments_raw, frames_data, answers } = req.body;
  try {
    const r = await pool.query(`INSERT INTO videos (url,title,views,likes,comment_count,analysis,copy_original,comments_raw,frames_data,answers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title,views=EXCLUDED.views,likes=EXCLUDED.likes,comment_count=EXCLUDED.comment_count,analysis=EXCLUDED.analysis,copy_original=EXCLUDED.copy_original,comments_raw=EXCLUDED.comments_raw,frames_data=EXCLUDED.frames_data,answers=EXCLUDED.answers,timestamp=NOW() RETURNING *`,
      [url,title,views,likes,comment_count,analysis,copy_original,comments_raw,frames_data||'[]',JSON.stringify(answers||[])]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/videos/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM videos WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GLOSARIO ----
app.get('/glosario', requireAuth, async (req, res) => {
  try { const r=await pool.query('SELECT * FROM glosario ORDER BY created_at ASC'); const obj={}; r.rows.forEach(row=>obj[row.key]=row.value); res.json(obj); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/glosario', requireAuth, async (req, res) => {
  const { key, value } = req.body;
  try { await pool.query(`INSERT INTO glosario (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,[key,value]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PATRONES ----
app.get('/patrones', requireAuth, async (req, res) => {
  try { res.json((await pool.query('SELECT patron FROM patrones ORDER BY created_at ASC')).rows.map(r=>r.patron)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/patrones', requireAuth, async (req, res) => {
  const { patron } = req.body;
  try { await pool.query(`INSERT INTO patrones (patron) VALUES ($1) ON CONFLICT (patron) DO NOTHING`,[patron]); res.json({ok:true}); }
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
