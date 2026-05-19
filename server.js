const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/', limits: { fileSize: 100 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      analysis TEXT,
      answers JSONB DEFAULT '[]',
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      status TEXT DEFAULT 'analyzed'
    );
    CREATE TABLE IF NOT EXISTS glosario (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS patrones (
      id SERIAL PRIMARY KEY,
      patron TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'sudaca-brain' }));

// ---- ANALYZE (multipart upload) ----
app.post('/analyze', upload.single('video'), async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  console.log('--- /analyze request ---');
  console.log('file:', req.file ? `${req.file.originalname} ${req.file.size} bytes` : 'NO FILE');
  console.log('body keys:', Object.keys(req.body));
  console.log('url:', req.body.url);
  console.log('title:', req.body.title);

  const { url, title, views, likes, comment_count, comments, glosario, patrones } = req.body;
  
  let glosarioObj = {};
  let patronesArr = [];
  try { glosarioObj = JSON.parse(glosario || '{}'); } catch(e) {}
  try { patronesArr = JSON.parse(patrones || '[]'); } catch(e) {}

  const glosarioStr = Object.entries(glosarioObj).length > 0
    ? 'Glosario conocido de Javier: ' + Object.entries(glosarioObj).map(([k,v]) => `"${k}" = ${v}`).join(', ')
    : 'No hay glosario previo todavía.';

  const prompt = `Sos un analizador experto del creador de contenido Javier Romero, conocido como "Joyería Sudaca". 

CONTEXTO DEL CREADOR:
Javier es joyero argentino con ~105K suscriptores en YouTube y ~170K seguidores totales. Sus Shorts son famosos por:
- Sarcasmo e ironía: dice una cosa y muestra otra, o nombra las cosas de forma absurda y grandilocuente
- Nombres inventados para materiales reales (ej: bórax = "sal del himalaya" o "lágrimas de ángel", ácido nítrico = "bebida de los pueblos nobles", lima = "supositorio del joyero")
- Los nombres NO son siempre iguales, varían
- Humor de taller: chistes sobre herramientas, metales, procesos químicos
- Frases características como "porque esto es joyería sudaca papá"
- Cuarta pared, anticlímax, resignación activa

${glosarioStr}
Patrones previos: ${patronesArr.join(', ') || 'ninguno aún'}

DATOS DEL VIDEO:
URL: ${url}, Título: ${title}
Views: ${views || '?'}, Likes: ${likes || '?'}
Comentarios: ${comments || 'No proporcionados.'}

ANALIZÁ CON MÁXIMO DETALLE:

## ANÁLISIS VISUAL
Qué se ve exactamente: materiales, herramientas, procesos, acciones momento a momento.

## ANÁLISIS DEL DISCURSO
Transcripción frase por frase. Ritmo, pausas, énfasis.

## CRUCES VISUAL/VERBAL (CRÍTICO)
Cada momento donde hay contradicción, ironía o humor entre lo visual y lo verbal. Explicá el mecanismo del chiste.

## ESTRUCTURA NARRATIVA
- Gancho (primeros 3 segundos)
- Desarrollo
- Remate/cierre

## ANÁLISIS DE COMENTARIOS
Qué resonó, qué emociones expresan, qué momento del video generó cada reacción.

## GLOSARIO DETECTADO
Nombres inventados nuevos. Formato: TÉRMINO_USADO → qué es realmente

## PATRONES REPLICABLES
Qué recursos tienen potencial de replicarse y por qué funcionaron.

## PREGUNTAS PARA JAVIER
Dudas concretas sobre el video. Formato: PREGUNTA_N: [pregunta]

Sé exhaustivo. El video se descarta después de este análisis.`;

  try {
    let messages;

    if (req.file) {
      const videoBuffer = fs.readFileSync(req.file.path);
      const videoBase64 = videoBuffer.toString('base64');
      const mimeType = req.file.mimetype || 'video/mp4';
      
      messages = [{
        role: 'user',
        content: [
          { type: 'video', source: { type: 'base64', media_type: mimeType, data: videoBase64 } },
          { type: 'text', text: prompt }
        ]
      }];

      // Cleanup temp file
      fs.unlinkSync(req.file.path);
    } else {
      messages = [{ role: 'user', content: prompt }];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ analysis: data.content[0].text });

  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

// ---- REFINE ----
app.post('/refine', async (req, res) => {
  const { analysis, answers } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const prompt = `Tenés este análisis de un video de Joyería Sudaca:\n\n${analysis}\n\nJavier respondió estas preguntas:\n${answers.map(a => `P: ${a.question}\nR: ${a.answer}`).join('\n\n')}\n\nActualizá el GLOSARIO DETECTADO y los PATRONES REPLICABLES. Devolvé solo esas dos secciones actualizadas.`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    res.json({ refined: data.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE ----
app.post('/generate', async (req, res) => {
  const { description, momento, tono, glosario, patrones, contextVideos } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const prompt = `Sos el asistente creativo de Javier "Joyería Sudaca" Romero.

Glosario: ${Object.entries(glosario||{}).map(([k,v])=>`"${k}"=${v}`).join(', ')||'En construcción'}
Patrones: ${(patrones||[]).join(', ')||'En construcción'}
Videos previos (resumen): ${(contextVideos||[]).slice(-3).map(v=>`${v.views} views: ${(v.analysis||'').substring(0,400)}`).join('\n---\n')}

NUEVO VIDEO: ${description}
Momento: ${momento}, Tono: ${tono}

GENERÁ 3 OPCIONES DE COPY. Cada una:
- OPCIÓN_N: [nombre]
- PATRÓN USADO: [mecanismo]
- COPY COMPLETO: [guión]
- NOMBRES SUGERIDOS: [variantes nuevas si aplica]

No repetir frases exactas de videos anteriores. Replicar el MECANISMO, no las palabras.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    res.json({ copy: data.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- VIDEOS ----
app.get('/videos', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM videos ORDER BY timestamp DESC'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/videos', async (req, res) => {
  const { url, title, views, likes, comment_count, analysis, answers } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO videos (url, title, views, likes, comment_count, analysis, answers)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title, views=EXCLUDED.views, likes=EXCLUDED.likes,
      comment_count=EXCLUDED.comment_count, analysis=EXCLUDED.analysis, answers=EXCLUDED.answers, timestamp=NOW()
      RETURNING *`, [url, title, views, likes, comment_count, analysis, JSON.stringify(answers||[])]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/videos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM videos WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GLOSARIO ----
app.get('/glosario', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM glosario ORDER BY created_at ASC');
    const obj = {}; r.rows.forEach(row => obj[row.key] = row.value); res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/glosario', async (req, res) => {
  const { key, value } = req.body;
  try { await pool.query(`INSERT INTO glosario (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,[key,value]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PATRONES ----
app.get('/patrones', async (req, res) => {
  try { const r = await pool.query('SELECT patron FROM patrones ORDER BY created_at ASC'); res.json(r.rows.map(r=>r.patron)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/patrones', async (req, res) => {
  const { patron } = req.body;
  try { await pool.query(`INSERT INTO patrones (patron) VALUES ($1) ON CONFLICT (patron) DO NOTHING`,[patron]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- STATS ----
app.get('/stats', async (req, res) => {
  try {
    const [v,g,p] = await Promise.all([pool.query('SELECT COUNT(*) FROM videos'),pool.query('SELECT COUNT(*) FROM glosario'),pool.query('SELECT COUNT(*) FROM patrones')]);
    res.json({ videos: parseInt(v.rows[0].count), glosario: parseInt(g.rows[0].count), patrones: parseInt(p.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => app.listen(PORT, () => console.log(`Sudaca Brain backend running on port ${PORT}`)));
