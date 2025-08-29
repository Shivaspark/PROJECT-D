const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8081;

app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));

function basicAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.split(' ')[1] || '';
  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (ADMIN_USER && ADMIN_PASS && user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Authentication required');
}

const DB_PATH = path.join(__dirname, 'data', 'projects.json');
function readDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { projects: [] };
  }
}
function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Postgres (Neon) setup
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  (async () => {
    try {
      await pool.query(`
        create table if not exists projects (
          id text primary key,
          type text not null check (type in ('flagship','upcoming')),
          title text not null,
          description text not null,
          image text not null
        )
      `);
    } catch (e) {
      console.error('DB init failed:', e.message);
    }
  })();
}

async function dbGetProjects(type) {
  if (pool) {
    const params = [];
    let sql = 'select id, type, title, description, image from projects';
    if (type === 'flagship' || type === 'upcoming') {
      sql += ' where type = $1';
      params.push(type);
    }
    sql += ' order by title asc';
    const { rows } = await pool.query(sql, params);
    return rows;
  } else {
    const db = readDb();
    let items = db.projects || [];
    if (type === 'flagship' || type === 'upcoming') items = items.filter(p => p.type === type);
    return items;
  }
}
async function dbCreateProject({ id, title, description, image, type }) {
  const newId = id || `${type}-${Date.now()}`;
  if (pool) {
    await pool.query(
      'insert into projects (id, type, title, description, image) values ($1,$2,$3,$4,$5) on conflict (id) do update set type=excluded.type, title=excluded.title, description=excluded.description, image=excluded.image',
      [newId, type, title, description, image]
    );
    const { rows } = await pool.query('select id, type, title, description, image from projects where id=$1', [newId]);
    return rows[0];
  } else {
    const db = readDb();
    const item = { id: newId, title, description, image, type };
    db.projects.push(item);
    writeDb(db);
    return item;
  }
}
async function dbUpdateProject(id, { title, description, image, type }) {
  if (pool) {
    const { rows } = await pool.query('select 1 from projects where id=$1', [id]);
    if (!rows.length) return null;
    await pool.query('update projects set title=$1, description=$2, image=$3, type=$4 where id=$5', [title, description, image, type, id]);
    const result = await pool.query('select id, type, title, description, image from projects where id=$1', [id]);
    return result.rows[0];
  } else {
    const db = readDb();
    const idx = db.projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    db.projects[idx] = { ...db.projects[idx], title, description, image, type: type || db.projects[idx].type };
    writeDb(db);
    return db.projects[idx];
  }
}
async function dbDeleteProject(id) {
  if (pool) {
    const { rows } = await pool.query('delete from projects where id=$1 returning id', [id]);
    return rows.length > 0;
  } else {
    const db = readDb();
    const before = db.projects.length;
    db.projects = db.projects.filter(p => p.id !== id);
    writeDb(db);
    return db.projects.length < before;
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'RAC IIE.html'));
});

// Admin page
app.get('/admin', basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Gallery API
app.get('/api/gallery', (req, res) => {
  const galleryDir = path.join(__dirname, 'assets', 'images', 'gallery');
  const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
  fs.readdir(galleryDir, (err, files) => {
    if (err) return res.json({ images: [] });
    const images = files.filter(f => allowed.has(path.extname(f).toLowerCase())).map(f => `assets/images/gallery/${f}`);
    res.json({ images });
  });
});

// Projects API (CRUD)
app.get('/api/projects', async (req, res) => {
  try {
    const { type } = req.query;
    const items = await dbGetProjects(type);
    res.json({ projects: items });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

app.post('/api/projects', basicAuth, async (req, res) => {
  const { id, title, description, image, type } = req.body;
  if (!title || !description || !image || !type) return res.status(400).json({ error: 'Missing fields' });
  try {
    const created = await dbCreateProject({ id, title, description, image, type });
    res.status(201).json({ project: created });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create' });
  }
});

app.put('/api/projects/:id', basicAuth, async (req, res) => {
  const { id } = req.params;
  const { title, description, image, type } = req.body;
  try {
    const updated = await dbUpdateProject(id, { title, description, image, type });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ project: updated });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

app.delete('/api/projects/:id', basicAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const ok = await dbDeleteProject(id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Rotaract Club website running on http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${__dirname}`);
});
