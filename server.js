const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const VERSION = '1.4.0';
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/', limits: { fileSize: 100 * 1024 * 1024 } });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
      copy_original TEXT,
      comments_raw TEXT,
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
  // Add new columns if they don't exist (for existing DBs)
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS copy_original TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS comments_raw TEXT`).catch(()=>{});
  console.log('DB ready');
}

const callClaude = async (messages, maxTokens = 4000) => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
};

app.get('/', (req, res) => res.json({ status: 'ok', service: 'sudaca-brain', version: VERSION }));

// ---- ANALYZE ----
app.post('/analyze', upload.single('video'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  console.log(`[v${VERSION}] /analyze - file: ${req.file ? req.file.size + ' bytes' : 'NO FILE'}`);

  const { url, title, views, likes, comment_count, comments, copy_original, glosario, patrones } = req.body;

  let glosarioObj = {};
  let patronesArr = [];
  try { glosarioObj = JSON.parse(glosario || '{}'); } catch(e) {}
  try { patronesArr = JSON.parse(patrones || '[]'); } catch(e) {}

  const glosarioStr = Object.entries(glosarioObj).length > 0
    ? 'Glosario conocido: ' + Object.entries(glosarioObj).map(([k,v]) => `"${k}" = ${v}`).join(', ')
    : 'Sin glosario previo.';

  const prompt = `Sos un analizador experto del creador Javier Romero "Joyería Sudaca".

CONTEXTO:
- Joyero argentino, ~105K suscriptores YouTube, ~170K seguidores totales
- Sus Shorts: sarcasmo e ironía, dice una cosa y muestra otra
- Nombres inventados para materiales (bórax = "sal del himalaya"/"lágrimas de ángel", ácido nítrico = "bebida de los pueblos nobles", lima = "supositorio del joyero") — VARÍAN, no son fijos
- Humor de taller, cuarta pared, anticlímax, resignación activa
- Frase característica: "porque esto es joyería sudaca papá"

${glosarioStr}
Patrones previos: ${patronesArr.join(', ') || 'ninguno aún'}

VIDEO:
URL: ${url}
Título: ${title}
Views: ${views || '?'} | Likes: ${likes || '?'}

COPY ORIGINAL DEL VIDEO (lo que Javier dice exactamente):
${copy_original || 'No proporcionado — inferir del análisis visual'}

COMENTARIOS:
${comments || 'No proporcionados'}

ANALIZÁ CON MÁXIMO DETALLE:

## ANÁLISIS VISUAL
Describí frame a frame: materiales, herramientas, procesos, acciones, ambiente del taller.

## ANÁLISIS DEL DISCURSO
${copy_original ? 'Con el copy original disponible, analizá cada frase: tono, ritmo, énfasis, intención.' : 'Inferí el discurso desde los frames. Transcribí lo más posible.'}

## CRUCES VISUAL/VERBAL (CRÍTICO)
Cada contradicción, ironía o humor entre lo que se ve y lo que se dice. Explicá el mecanismo exacto del chiste en cada caso. Identificá qué nombre inventado usó y por qué funciona.

## ESTRUCTURA NARRATIVA
- GANCHO (primeros 3 segundos): qué dice/muestra para enganchar
- DESARROLLO: cómo mantiene la atención
- REMATE: cómo cierra, qué recurso usa

## ANÁLISIS DE COMENTARIOS
- Qué resonó más y por qué
- Qué momento específico del video generó cada reacción
- PEDIDOS DE CONTENIDO: comentarios donde la gente pide que muestre algo específico

## GLOSARIO DETECTADO
Nombres inventados nuevos detectados. Formato: TÉRMINO_USADO → qué es realmente

## PATRONES REPLICABLES
Recursos con potencial de replicarse. Por qué funcionaron. Qué variaciones podrían hacerse.

## PREGUNTAS PARA JAVIER
Solo preguntas genuinamente importantes para entender mejor el video.
Formato: PREGUNTA_N: [pregunta concreta]

S  exhaustivo y específico. El video se descarta tras este análisis.`;

  try {
    let frameImages = [];
    let audioTranscription = '';

    if (req.file) {
      const timestamp = Date.now();
      const framesDir = `/tmp/frames_${timestamp}`;
      const audioPath = `/tmp/audio_${timestamp}.mp3`;
      fs.mkdirSync(framesDir, { recursive: true });

      // Extract frames
      try {
        execSync(`ffmpeg -i "${req.file.path}" -vf "fps=1/5,scale=480:-1" -frames:v 10 "${framesDir}/frame_%03d.jpg" -y 2>/dev/null`);
        const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
        console.log(`Extracted ${frameFiles.length} frames`);
        frameImages = frameFiles.map(f => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(framesDir, f)).toString('base64') }
        }));
        frameFiles.forEach(f => fs.unlinkSync(path.join(framesDir, f)));
        fs.rmdirSync(framesDir);
      } catch(e) { console.log('ffmpeg frames error:', e.message); }

      // Extract audio and transcribe with Claude
      try {
        execSync(`ffmpeg -i "${req.file.path}" -vn -ac 1 -ar 16000 -ab 64k "${audioPath}" -y 2>/dev/null`);
        const audioBuffer = fs.readFileSync(audioPath);
        const audioBase64 = audioBuffer.toString('base64');
        console.log(`Audio extracted: ${(audioBuffer.length/1024).toFixed(0)}KB`);

        const transcriptResponse = await callClaude([{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'audio/mpeg', data: audioBase64 }
            },
            {
              type: 'text',
              text: `Transcribí este audio de un video de YouTube de un joyero argentino llamado Javier "Joyería Sudaca". 
              
Transcribí exactamente lo que dice, incluyendo:
- Timestamps aproximados cada frase [0:00] [0:05] etc
- El tono y énfasis cuando sea notable (mayúsculas para énfasis fuerte)
- Pausas significativas con [pausa]
- Risas o sonidos relevantes entre corchetes
- Errores o dudas tal como salen

Devolvé solo la transcripción, sin comentarios adicionales.`
            }
          ]
        }], 2000);

        audioTranscription = transcriptResponse;
        console.log('Audio transcribed successfully');
        fs.unlinkSync(audioPath);
      } catch(e) {
        console.log('Audio transcription error:', e.message);
        try { fs.unlinkSync(audioPath); } catch(e2) {}
      }

      fs.unlinkSync(req.file.path);
    }

    const audioContext = audioTranscription
      ? `\n\nTRANSCRIPCIÓN DE AUDIO CON TIMESTAMPS:\n${audioTranscription}\n\nUsá esta transcripción para entender el ritmo, énfasis, timing exacto de los chistes y cómo construye el humor.\n`
      : '';

    const messages = [{
      role: 'user',
      content: frameImages.length > 0
        ? [{ type: 'text', text: `${frameImages.length} frames del video (orden cronológico) + transcripción de audio:${audioContext}\n\n${prompt}` }, ...frameImages]
        : prompt + audioContext
    }];

    const analysis = await callClaude(messages, 4000);
    res.json({ analysis });

  } catch (err) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

// ---- REFINE ----
app.post('/refine', async (req, res) => {
  const { analysis, answers } = req.body;
  try {
    const refined = await callClaude([{ role: 'user', content: `Análisis de video de Joyería Sudaca:\n\n${analysis}\n\nJavier respondió:\n${answers.map(a=>`P: ${a.question}\nR: ${a.answer}`).join('\n\n')}\n\nActualizá solo GLOSARIO DETECTADO y PATRONES REPLICABLES incorporando las respuestas.` }], 1000);
    res.json({ refined });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE COPY ----
app.post('/generate', async (req, res) => {
  const { description, momento, tono, glosario, patrones, contextVideos } = req.body;
  try {
    const copy = await callClaude([{ role: 'user', content: `Sos el asistente creativo de Javier "Joyería Sudaca" Romero.

Glosario: ${Object.entries(glosario||{}).map(([k,v])=>`"${k}"=${v}`).join(', ')||'En construcción'}
Patrones probados: ${(patrones||[]).join(' | ')||'En construcción'}
Videos previos: ${(contextVideos||[]).slice(-4).map(v=>`[${parseInt(v.views)?.toLocaleString()} views] ${(v.analysis||'').substring(0,600)}`).join('\n---\n')}

NUEVO VIDEO: ${description}
Momento del proceso: ${momento}
Tono: ${tono}

GENERÁ 3 OPCIONES DE COPY distintas en mecanismo:

Para cada opción:
OPCIÓN_N: [nombre del enfoque]
PATRÓN USADO: [qué mecanismo replica y por qué va a funcionar]
COPY COMPLETO: [guión exacto, listo para usar]
NOMBRES SUGERIDOS: [si hay materiales, sugerí 2-3 nombres inventados nuevos que no hayas usado antes]

Reglas: NO repetir frases exactas. Replicar el MECANISMO, no las palabras. Cada opción tiene que ser genuinamente diferente en enfoque.` }], 2000);
    res.json({ copy });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GENERATE IDEAS FROM COMMENTS ----
app.post('/ideas', async (req, res) => {
  const { videos } = req.body;
  if (!videos || videos.length === 0) return res.status(400).json({ error: 'No hay videos para analizar' });

  const allComments = videos.map(v => `VIDEO: ${v.title}\n${v.comments_raw || ''}`).join('\n\n---\n\n');
  const allAnalysis = videos.map(v => v.analysis || '').join('\n\n---\n\n');

  try {
    const ideas = await callClaude([{ role: 'user', content: `Sos el estratega de contenido de Javier "Joyería Sudaca" Romero.

Analizaste ${videos.length} videos con sus comentarios. Extraé ideas de contenido concretas.

COMENTARIOS DE TODOS LOS VIDEOS:
${allComments}

ANÁLISIS PREVIOS:
${allAnalysis.substring(0, 3000)}

GENERÁ:

## PEDIDOS RECURRENTES DE LA AUDIENCIA
Qué contenido pide la gente en los comentarios, agrupado por tema. Ejemplos concretos de comentarios.

## IDEAS DE CONTENIDO BASADAS EN COMENTARIOS
10 ideas concretas de videos, en orden de potencial viral estimado. Para cada una:
- IDEA: [descripción del video]
- BASADA EN: [comentarios que la sugieren]
- GANCHO SUGERIDO: [cómo arrancar el video]
- POTENCIAL: [por qué puede funcionar bien]

## TEMAS QUE LA AUDIENCIA QUIERE VER MÁS
Patrones generales de lo que más le interesa a tu audiencia.

## FORMATOS QUE GENERAN MÁS REACCIÓN
Qué tipo de contenido (proceso, resultado, error, comparación) genera más comentarios.` }], 3000);
    res.json({ ideas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- VIDEOS CRUD ----
app.get('/videos', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM videos ORDER BY views DESC')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/videos', async (req, res) => {
  const { url, title, views, likes, comment_count, analysis, copy_original, comments_raw, answers } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO videos (url, title, views, likes, comment_count, analysis, copy_original, comments_raw, answers)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (url) DO UPDATE SET
        title=EXCLUDED.title, views=EXCLUDED.views, likes=EXCLUDED.likes,
        comment_count=EXCLUDED.comment_count, analysis=EXCLUDED.analysis,
        copy_original=EXCLUDED.copy_original, comments_raw=EXCLUDED.comments_raw,
        answers=EXCLUDED.answers, timestamp=NOW()
      RETURNING *`,
      [url, title, views, likes, comment_count, analysis, copy_original, comments_raw, JSON.stringify(answers||[])]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/videos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM videos WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
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
  try { await pool.query(`INSERT INTO glosario (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key,value]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PATRONES ----
app.get('/patrones', async (req, res) => {
  try { res.json((await pool.query('SELECT patron FROM patrones ORDER BY created_at ASC')).rows.map(r=>r.patron)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/patrones', async (req, res) => {
  const { patron } = req.body;
  try { await pool.query(`INSERT INTO patrones (patron) VALUES ($1) ON CONFLICT (patron) DO NOTHING`, [patron]); res.json({ok:true}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- STATS ----
app.get('/stats', async (req, res) => {
  try {
    const [v,g,p] = await Promise.all([pool.query('SELECT COUNT(*) FROM videos'), pool.query('SELECT COUNT(*) FROM glosario'), pool.query('SELECT COUNT(*) FROM patrones')]);
    res.json({ videos: parseInt(v.rows[0].count), glosario: parseInt(g.rows[0].count), patrones: parseInt(p.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => app.listen(PORT, () => console.log(`Sudaca Brain v${VERSION} running on port ${PORT}`)));
