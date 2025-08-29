const express = require('express');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 8081;

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

// MongoDB setup
let mongoClient = null;
let mongoDb = null;
let projectsCol = null;

async function ensureMongo() {
  if (projectsCol) return projectsCol;
  const uri = process.env.MONGODB_URI || (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('mongodb') ? process.env.DATABASE_URL : null);
  if (!uri) return null;
  mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  const dbName = process.env.MONGODB_DB || 'rotaract';
  mongoDb = mongoClient.db(dbName);
  projectsCol = mongoDb.collection('projects');
  try {
    await projectsCol.createIndex({ id: 1 }, { unique: true });
  } catch (e) {
    // ignore index creation errors (may already exist)
  }
  return projectsCol;
}

async function dbGetProjects(type) {
  const col = await ensureMongo();
  if (col) {
    const query = (type === 'flagship' || type === 'upcoming') ? { type } : {};
    const items = await col.find(query).sort({ title: 1 }).toArray();
    return items.map(({ id, type, title, description, image }) => ({ id, type, title, description, image }));
  } else {
    const db = readDb();
    let items = db.projects || [];
    if (type === 'flagship' || type === 'upcoming') items = items.filter(p => p.type === type);
    return items;
  }
}
async function dbCreateProject({ id, title, description, image, type }) {
  const newId = id || `${type}-${Date.now()}`;
  const col = await ensureMongo();
  if (col) {
    await col.updateOne(
      { id: newId },
      { $set: { id: newId, type, title, description, image } },
      { upsert: true }
    );
    const created = await col.findOne({ id: newId }, { projection: { _id: 0 } });
    return created;
  } else {
    const db = readDb();
    const item = { id: newId, title, description, image, type };
    const existingIdx = db.projects.findIndex(p => p.id === newId);
    if (existingIdx !== -1) db.projects[existingIdx] = item; else db.projects.push(item);
    writeDb(db);
    return item;
  }
}
async function dbUpdateProject(id, { title, description, image, type }) {
  const col = await ensureMongo();
  if (col) {
    const exists = await col.findOne({ id });
    if (!exists) return null;
    await col.updateOne({ id }, { $set: { title, description, image, type: type || exists.type } });
    const updated = await col.findOne({ id }, { projection: { _id: 0 } });
    return updated;
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
  const col = await ensureMongo();
  if (col) {
    const { deletedCount } = await col.deleteOne({ id });
    return deletedCount > 0;
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

// Also protect direct access to admin.html
app.get('/admin.html', basicAuth, (req, res) => {
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

// DB Health
app.get('/api/health/db', async (req, res) => {
  try {
    const col = await ensureMongo();
    if (!col) {
      const local = readDb();
      return res.json({ connected: false, provider: 'json', message: 'MONGODB_URI not set or unreachable', count: (local.projects||[]).length });
    }
    await mongoDb.command({ ping: 1 });
    const count = await col.countDocuments();
    return res.json({ connected: true, provider: 'mongodb', db: mongoDb.databaseName, count });
  } catch (e) {
    return res.status(500).json({ connected: false, provider: 'mongodb', error: e.message });
  }
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
    if (e && e.code === 11000) return res.status(409).json({ error: 'Duplicate id' });
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

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`🚀 Rotaract Club website running on http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${__dirname}`);
});
