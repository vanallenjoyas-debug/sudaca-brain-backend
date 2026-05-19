const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '150mb' }));

// Init tables
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

// Health
app.get('/', (req, res) => res.json({ status: 'ok', service: 'sudaca-brain' }));

// ---- ANALYZE ----
app.post('/analyze', async (req, res) => {
  const { videoBase64, mimeType, url, title, views, likes, comment_count, comments, glosario, patrones, contextVideos } = req.body;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada' });

  const glosarioStr = Object.entries(glosario || {}).length > 0
    ? 'Glosario conocido de Javier: ' + Object.entries(glosario).map(([k,v]) => `"${k}" = ${v}`).join(', ')
    : 'No hay glosario previo todavía.';

  const contextPrevio = (contextVideos && contextVideos.length > 0)
    ? `Ya analizaste ${contextVideos.length} video(s) anteriores. Patrones identificados: ${(patrones || []).join(', ') || 'ninguno aún'}.`
    : 'Este es el primer video analizado.';

  const prompt = `Sos un analizador experto del creador de contenido Javier Romero, conocido como "Joyería Sudaca". 

CONTEXTO DEL CREADOR:
Javier es joyero argentino con ~105K suscriptores en YouTube y ~170K seguidores totales. Sus Shorts son famosos por:
- Sarcasmo e ironía: dice una cosa y muestra otra, o nombra las cosas de forma absurda y grandilocuente
- Nombres inventados para materiales reales (ej: bórax = "sal del himalaya" o "lágrimas de ángel", ácido nítrico = "bebida de los pueblos nobles", lima = "supositorio del joyero")
- Los nombres NO son siempre iguales, varían. A veces usa uno, a veces otro, a veces inventa uno nuevo
- Humor de taller: chistes sobre herramientas, metales, procesos químicos
- Frases características como "porque esto es joyería sudaca papá"
- Cuarta pared: habla directo a cámara, rompe el formato
- Anticlímax: construye expectativa y remata con algo absurdo o mundano
- Resignación activa: acepta lo malo del proceso como si fuera normal

${glosarioStr}
${contextPrevio}

DATOS DEL VIDEO:
URL YouTube: ${url}
Título: ${title}
Views: ${views || 'no proporcionado'}
Likes: ${likes || 'no proporcionado'}
Comentarios del video:
${comments || 'No se proporcionaron comentarios.'}

TU TAREA - Analizá el video con MÁXIMO DETALLE:

## ANÁLISIS VISUAL
Describí en detalle qué se ve: materiales, herramientas, procesos, ambiente del taller, acciones específicas momento a momento.

## ANÁLISIS DEL DISCURSO
Transcribí y analizá exactamente qué dice Javier, frase por frase. Identificá el ritmo, las pausas, los énfasis.

## CRUCES VISUAL/VERBAL (CRÍTICO)
Identificá cada momento donde hay contradicción, ironía o humor entre lo que se ve y lo que se dice. Explicá el mecanismo del chiste o recurso en cada caso.

## ESTRUCTURA NARRATIVA
- Gancho de apertura (primeros 3 segundos): ¿cómo engancha?
- Desarrollo: ¿cómo mantiene la atención?
- Remate/cierre: ¿cómo termina?

## ANÁLISIS DE COMENTARIOS
Si hay comentarios, analizá: ¿qué les resonó? ¿Comentan sobre algo visual, algo que dijo, un nombre inventado específico? ¿Qué emociones expresan?

## GLOSARIO DETECTADO
Lista cualquier nombre inventado, frase especial o recurso lingüístico que uses en este video. Formato: TÉRMINO_USADO → qué es realmente

## PATRONES REPLICABLES
¿Qué recursos de este video tienen potencial de replicarse en otros contextos? ¿Por qué funcionaron?

## PREGUNTAS PARA JAVIER
Si hay algo que no entendiste, listalo como preguntas concretas.
Formato: PREGUNTA_N: [tu pregunta específica]

Sé exhaustivo. Este análisis queda guardado permanentemente. El video se descarta después.`;

  try {
    const messages = videoBase64 ? [{
      role: 'user',
      content: [
        { type: 'video', source: { type: 'base64', media_type: mimeType || 'video/mp4', data: videoBase64 } },
        { type: 'text', text: prompt }
      ]
    }] : [{
      role: 'user',
      content: prompt
    }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ analysis: data.content[0].text });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- REFINE (post-answers) ----
app.post('/refine', async (req, res) => {
  const { analysis, answers } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const prompt = `Tenés este análisis de un video de Joyería Sudaca:

${analysis}

Javier respondió estas preguntas:
${answers.map(a => `P: ${a.question}\nR: ${a.answer}`).join('\n\n')}

Actualizá el GLOSARIO DETECTADO y los PATRONES REPLICABLES incorporando estas respuestas. Devolvé solo las dos secciones actualizadas.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    res.json({ refined: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GENERATE COPY ----
app.post('/generate', async (req, res) => {
  const { description, momento, tono, glosario, patrones, contextVideos } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const prompt = `Sos el asistente creativo de Javier "Joyería Sudaca" Romero.

CONOCIMIENTO ACUMULADO DE JAVIER:

Glosario (nombres que usa para las cosas):
${Object.entries(glosario || {}).map(([k,v]) => `"${k}" = ${v}`).join('\n') || 'En construcción'}

Patrones que funcionan en sus videos:
${(patrones || []).join('\n') || 'En construcción'}

ANÁLISIS DE VIDEOS ANTERIORES (los más recientes):
${(contextVideos || []).slice(-5).map(v => `Video (${v.views?.toLocaleString() || '?'} views, ${v.likes?.toLocaleString() || '?'} likes):\n${v.analysis ? v.analysis.substring(0, 800) : ''}`).join('\n\n---\n\n')}

NUEVO VIDEO A GENERAR:
Descripción: ${description}
Momento del proceso: ${momento}
Tono preferido: ${tono}

GENERÁ 3 OPCIONES DE COPY para este video. Cada opción debe:
1. Usar el estilo de Javier (sarcasmo, nombres inventados, estructura narrativa probada)
2. NO repetir frases exactas de videos anteriores, sino replicar el MECANISMO
3. Si aplica un nombre inventado para algo, que sea NUEVO o una variación no usada
4. Incluir: gancho de apertura + desarrollo + remate/cierre
5. Señalar qué patrón o recurso está usando en cada opción

Para cada opción indicá:
- OPCIÓN_N: [nombre del enfoque]
- PATRÓN USADO: [qué mecanismo replica y por qué probablemente funcione]
- COPY COMPLETO: [el guión/copy]
- NOMBRES SUGERIDOS: [si hay materiales que nombrar, sugerí 2-3 variantes nuevas]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    res.json({ copy: data.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- VIDEOS ----
app.get('/videos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM videos ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/videos', async (req, res) => {
  const { url, title, views, likes, comment_count, analysis, answers } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO videos (url, title, views, likes, comment_count, analysis, answers)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (url) DO UPDATE SET
        title = EXCLUDED.title, views = EXCLUDED.views, likes = EXCLUDED.likes,
        comment_count = EXCLUDED.comment_count, analysis = EXCLUDED.analysis,
        answers = EXCLUDED.answers, timestamp = NOW()
      RETURNING *
    `, [url, title, views, likes, comment_count, analysis, JSON.stringify(answers || [])]);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/videos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM videos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GLOSARIO ----
app.get('/glosario', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM glosario ORDER BY created_at ASC');
    const obj = {};
    result.rows.forEach(r => obj[r.key] = r.value);
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/glosario', async (req, res) => {
  const { key, value } = req.body;
  try {
    await pool.query(`INSERT INTO glosario (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PATRONES ----
app.get('/patrones', async (req, res) => {
  try {
    const result = await pool.query('SELECT patron FROM patrones ORDER BY created_at ASC');
    res.json(result.rows.map(r => r.patron));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/patrones', async (req, res) => {
  const { patron } = req.body;
  try {
    await pool.query(`INSERT INTO patrones (patron) VALUES ($1) ON CONFLICT (patron) DO NOTHING`, [patron]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- STATS ----
app.get('/stats', async (req, res) => {
  try {
    const [v, g, p] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM videos'),
      pool.query('SELECT COUNT(*) FROM glosario'),
      pool.query('SELECT COUNT(*) FROM patrones')
    ]);
    res.json({ videos: parseInt(v.rows[0].count), glosario: parseInt(g.rows[0].count), patrones: parseInt(p.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`Sudaca Brain backend running on port ${PORT}`));
});
