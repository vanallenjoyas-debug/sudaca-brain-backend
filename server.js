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
app.use(express.json({ limit: '10mb' }));

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
        title = EXCLUDED.title,
        views = EXCLUDED.views,
        likes = EXCLUDED.likes,
        comment_count = EXCLUDED.comment_count,
        analysis = EXCLUDED.analysis,
        answers = EXCLUDED.answers,
        timestamp = NOW()
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
    await pool.query(`
      INSERT INTO glosario (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [key, value]);
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
    await pool.query(`
      INSERT INTO patrones (patron) VALUES ($1)
      ON CONFLICT (patron) DO NOTHING
    `, [patron]);
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
    res.json({
      videos: parseInt(v.rows[0].count),
      glosario: parseInt(g.rows[0].count),
      patrones: parseInt(p.rows[0].count)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`Sudaca Brain backend running on port ${PORT}`));
});
