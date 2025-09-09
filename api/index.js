const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { MongoClient, ServerApiVersion } = require('mongodb');
const multer = require('multer');
const serverless = require('serverless-http');
const { put } = require('@vercel/blob');

require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS for cross-origin frontend
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Normalize Vercel rewrite path: /api/(.*) -> /api/index/$1
// This lets existing '/api/...' routes keep working when the function is '/api/index.js'.
app.use((req, res, next) => {
  if (req.url === '/api/index') req.url = '/api';
  else if (req.url.startsWith('/api/index/')) req.url = req.url.replace(/^\/api\/index\//, '/api/');
  next();
});

// Helpers
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

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, 'data', 'projects.json');
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
let highlightsCol = null;
let powerStonesCol = null;
let bulletinsCol = null;
let leaderboardCol = null;

async function ensureMongo() {
  if (projectsCol) return projectsCol;
  const uri = process.env.MONGODB_URI || (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('mongodb') ? process.env.DATABASE_URL : null);
  if (!uri) return null;
  mongoClient = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  await mongoClient.connect();
  const dbName = process.env.MONGODB_DB || 'rotaract';
  mongoDb = mongoClient.db(dbName);
  projectsCol = mongoDb.collection('projects');
  try { await projectsCol.createIndex({ id: 1 }, { unique: true }); } catch {}
  return projectsCol;
}
async function ensureHighlights() {
  if (!mongoDb) { const col = await ensureMongo(); if (!col) return null; }
  if (!highlightsCol) {
    highlightsCol = mongoDb.collection('highlights');
    try {
      await highlightsCol.createIndex({ id: 1 }, { unique: true });
      await highlightsCol.createIndex({ order: 1 });
    } catch {}
  }
  return highlightsCol;
}
async function ensurePowerStones() {
  if (!mongoDb) { const col = await ensureMongo(); if (!col) return null; }
  if (!powerStonesCol) {
    powerStonesCol = mongoDb.collection('powerstones');
    try {
      await powerStonesCol.createIndex({ id: 1 }, { unique: true });
      await powerStonesCol.createIndex({ slot: 1 }, { unique: true });
    } catch {}
  }
  return powerStonesCol;
}
async function ensureBulletins() {
  if (!mongoDb) { const col = await ensureMongo(); if (!col) return null; }
  if (!bulletinsCol) {
    bulletinsCol = mongoDb.collection('bulletins');
    try {
      await bulletinsCol.createIndex({ id: 1 }, { unique: true });
      await bulletinsCol.createIndex({ lang: 1, date: -1 });
      await bulletinsCol.createIndex({ createdAt: -1 });
    } catch {}
  }
  return bulletinsCol;
}

async function ensureLeaderboard() {
  if (!mongoDb) { const col = await ensureMongo(); if (!col) return null; }
  if (!leaderboardCol) {
    leaderboardCol = mongoDb.collection('leaderboard');
    try {
      await leaderboardCol.createIndex({ game: 1, score: -1 });
      await leaderboardCol.createIndex({ createdAt: -1 });
      await leaderboardCol.createIndex({ nickname: 1 });
    } catch {}
  }
  return leaderboardCol;
}

async function dbGetProjects(type) {
  const allowed = new Set(['flagship','existing','upcoming']);
  const col = await ensureMongo();
  if (col) {
    const query = allowed.has(type) ? { type } : {};
    const items = await col
      .find(query)
      .project({ _id: 0, id: 1, type: 1, title: 1, description: 1, image: 1 })
      .sort({ title: 1 })
      .toArray();
    if (items && items.length) return items;
    const local = readDb();
    let fallbacks = Array.isArray(local.projects) ? local.projects : [];
    if (allowed.has(type)) fallbacks = fallbacks.filter(p => p.type === type);
    return fallbacks;
  } else {
    const db = readDb();
    let items = db.projects || [];
    if (allowed.has(type)) items = items.filter(p => p.type === type);
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

// Routes (API only)
app.get('/api/gallery', (req, res) => {
  const galleryDir = path.join(ROOT, 'assets', 'images', 'gallery');
  const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
  fs.readdir(galleryDir, (err, files) => {
    if (err) return res.json({ images: [] });
    const images = files.filter(f => allowed.has(path.extname(f).toLowerCase())).map(f => `assets/images/gallery/${f}`);
    res.json({ images });
  });
});

app.get('/api/highlights', async (req, res) => {
  try {
    const col = await ensureHighlights();
    if (col) {
      const docs = await col.find({}).sort({ order: 1, title: 1 }).project({ _id: 0, src: 1 }).toArray();
      const images = docs.map(d => d.src).filter(Boolean);
      if (images.length) return res.json({ images });
    }
    const galleryDir = path.join(ROOT, 'assets', 'images', 'gallery');
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
    const files = fs.existsSync(galleryDir) ? fs.readdirSync(galleryDir) : [];
    const images = files.filter(f => allowed.has(path.extname(f).toLowerCase())).map(f => `assets/images/gallery/${f}`);
    return res.json({ images });
  } catch (e) {
    return res.status(500).json({ images: [], error: e.message });
  }
});

app.get('/api/highlights/admin', basicAuth, async (req, res) => {
  try {
    const col = await ensureHighlights();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const items = await col.find({}).sort({ order: 1, title: 1 }).project({ _id: 0, id: 1, src: 1, title: 1, order: 1 }).toArray();
    return res.json({ highlights: items });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load highlights' });
  }
});

app.post('/api/highlights', basicAuth, async (req, res) => {
  try {
    const { id, src, title, order } = req.body || {};
    if (!src || typeof src !== 'string' || !src.trim()) return res.status(400).json({ error: 'src is required' });
    const col = await ensureHighlights();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const nextOrder = Number.isFinite(order) ? order : (await col.countDocuments());
    const newId = id || `hl-${Date.now()}`;
    await col.updateOne(
      { id: newId },
      { $set: { id: newId, src: src.trim(), title: title || '', order: nextOrder } },
      { upsert: true }
    );
    const created = await col.findOne({ id: newId }, { projection: { _id: 0 } });
    return res.status(201).json({ highlight: created });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Duplicate id' });
    return res.status(500).json({ error: 'Failed to create highlight' });
  }
});

app.put('/api/highlights/:id', basicAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { src, title, order } = req.body || {};
    const col = await ensureHighlights();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const exists = await col.findOne({ id });
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const update = {};
    if (typeof src === 'string') update.src = src.trim();
    if (typeof title === 'string') update.title = title;
    if (Number.isFinite(order)) update.order = order;
    await col.updateOne({ id }, { $set: update });
    const updated = await col.findOne({ id }, { projection: { _id: 0 } });
    return res.json({ highlight: updated });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update highlight' });
  }
});

app.delete('/api/highlights/:id', basicAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const col = await ensureHighlights();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete highlight' });
  }
});

// Fallback: update highlight via POST
app.post('/api/highlights/update', basicAuth, async (req, res) => {
  try {
    const { id, src, title, order } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const col = await ensureHighlights();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const exists = await col.findOne({ id });
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const update = {};
    if (typeof src === 'string') update.src = src.trim();
    if (typeof title === 'string') update.title = title;
    if (Number.isFinite(order)) update.order = order;
    await col.updateOne({ id }, { $set: update });
    const updated = await col.findOne({ id }, { projection: { _id: 0 } });
    return res.json({ highlight: updated });
  } catch (e) { return res.status(500).json({ error: 'Failed to update highlight' }); }
});

// Fallback: delete highlight via POST
app.post('/api/highlights/delete', basicAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const col = await ensureHighlights();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.json({ deleted: true, id });
  } catch (e) { return res.status(500).json({ error: 'Failed to delete highlight' }); }
});

app.get('/api/power-stones', async (req, res) => {
  try {
    const col = await ensurePowerStones();
    if (col) {
      const docs = await col.find({}).sort({ slot: 1 }).project({ _id: 0, id: 1, slot: 1, src: 1, title: 1 }).toArray();
      if (docs.length) return res.json({ stones: docs });
    }
    const defaults = [
      { slot: 1, id: 'ps-1', src: 'https://placehold.co/600x400/eab308/ffffff?text=Glory', title: 'Glory' },
      { slot: 2, id: 'ps-2', src: 'https://placehold.co/600x400/22c55e/ffffff?text=Conquest', title: 'Conquest' },
      { slot: 3, id: 'ps-3', src: 'https://placehold.co/600x400/8b5cf6/ffffff?text=Feast', title: 'Feast' },
      { slot: 4, id: 'ps-4', src: 'https://placehold.co/600x400/3b82f6/ffffff?text=Alliance', title: 'Alliance' },
      { slot: 5, id: 'ps-5', src: 'https://placehold.co/600x400/ef4444/ffffff?text=Council', title: 'Council' },
      { slot: 6, id: 'ps-6', src: 'https://placehold.co/600x400/14b8a6/ffffff?text=Valor', title: 'Valor' }
    ];
    return res.json({ stones: defaults });
  } catch (e) {
    return res.status(500).json({ stones: [], error: e.message });
  }
});

app.get('/api/power-stones/admin', basicAuth, async (req, res) => {
  try {
    const col = await ensurePowerStones();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const items = await col.find({}).sort({ slot: 1 }).project({ _id: 0 }).toArray();
    return res.json({ stones: items });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load stones' });
  }
});

app.post('/api/power-stones', basicAuth, async (req, res) => {
  try {
    const { id, slot, src, title } = req.body || {};
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) return res.status(400).json({ error: 'slot must be 1..6' });
    if (!src || typeof src !== 'string' || !src.trim()) return res.status(400).json({ error: 'src is required' });
    const col = await ensurePowerStones();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const newId = id || `ps-${slot}`;
    await col.updateOne({ slot }, { $set: { id: newId, slot, src: src.trim(), title: title || '' } }, { upsert: true });
    const saved = await col.findOne({ slot }, { projection: { _id: 0 } });
    return res.status(201).json({ stone: saved });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Duplicate key' });
    return res.status(500).json({ error: 'Failed to save stone' });
  }
});

app.delete('/api/power-stones/:id', basicAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const col = await ensurePowerStones();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete stone' });
  }
});

// Fallback: delete stone via POST
app.post('/api/power-stones/delete', basicAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const col = await ensurePowerStones();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.json({ deleted: true, id });
  } catch (e) { return res.status(500).json({ error: 'Failed to delete stone' }); }
});

app.get('/api/bulletins', async (req, res) => {
  try {
    const lang = (req.query.lang || 'ta').toLowerCase();
    const col = await ensureBulletins();
    if (col) {
      const items = await col.find({ lang }).sort({ date: -1, createdAt: -1 }).project({ _id: 0 }).toArray();
      const latest = items[0] || null;
      const archives = items.slice(1).map(({ id, title, date, pdf, lang }) => ({ id, title, date, pdf, lang }));
      if (latest) return res.json({ latest, archives });
    }
    const defaults = {
      ta: [{ id: 'ta-1', lang: 'ta', title: 'தமிழ் பதிப்பு', date: '2025-08-01', pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }],
      en: [{ id: 'en-1', lang: 'en', title: 'English Edition', date: '2025-08-01', pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }],
      kn: [{ id: 'kn-1', lang: 'kn', title: 'Kannada Edition', date: '2025-08-01', pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }],
      ml: [{ id: 'ml-1', lang: 'ml', title: 'Malayalam Edition', date: '2025-08-01', pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }],
      te: [{ id: 'te-1', lang: 'te', title: 'Telugu Edition', date: '2025-08-01', pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' }],
    };
    const arr = defaults[lang] || defaults.ta;
    return res.json({ latest: arr[0], archives: [] });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load bulletins' });
  }
});

app.get('/api/bulletins/admin', basicAuth, async (req, res) => {
  try {
    const col = await ensureBulletins();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const items = await col.find({}).sort({ date: -1, createdAt: -1 }).project({ _id: 0 }).toArray();
    return res.json({ bulletins: items });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load bulletins' });
  }
});

app.post('/api/bulletins', basicAuth, async (req, res) => {
  try {
    const { id, lang, title, pdf, date } = req.body || {};
    const L = new Set(['ta','en','kn','ml','te']);
    if (!L.has((lang||'').toLowerCase())) return res.status(400).json({ error: 'lang must be one of ta,en,kn,ml,te' });
    if (!pdf || typeof pdf !== 'string') return res.status(400).json({ error: 'pdf is required' });
    const col = await ensureBulletins();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const nid = id || `${lang}-${Date.now()}`;
    const doc = { id: nid, lang: lang.toLowerCase(), title: title || '', pdf: pdf.trim(), date: date || new Date().toISOString().slice(0,10), createdAt: new Date().toISOString() };
    await col.updateOne({ id: nid }, { $set: doc }, { upsert: true });
    const saved = await col.findOne({ id: nid }, { projection: { _id: 0 } });
    return res.status(201).json({ bulletin: saved });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Duplicate id' });
    return res.status(500).json({ error: 'Failed to save bulletin' });
  }
});

app.delete('/api/bulletins/:id', basicAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const col = await ensureBulletins();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete bulletin' });
  }
});

// Fallback: delete bulletin via POST
app.post('/api/bulletins/delete', basicAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const col = await ensureBulletins();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.json({ deleted: true, id });
  } catch (e) { return res.status(500).json({ error: 'Failed to delete bulletin' }); }
});

// Leaderboard API
app.get('/api/leaderboard', async (req, res) => {
  try {
    const col = await ensureLeaderboard();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 100);
    const game = typeof req.query.game === 'string' ? req.query.game.trim().toLowerCase() : '';
    if (col) {
      const query = game ? { game } : {};
      const items = await col.find(query).sort({ score: -1, createdAt: -1 }).limit(limit).project({ _id: 0 }).toArray();
      return res.json({ entries: items });
    } else {
      return res.json({ entries: [] });
    }
  } catch (e) {
    return res.status(500).json({ entries: [], error: 'Failed to load leaderboard' });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    const { game, nickname, score } = req.body || {};
    const G = new Set(['snake','whack','flight','memory']);
    const g = (game || '').toString().trim().toLowerCase();
    const name = (nickname || '').toString().trim().slice(0, 24);
    const sc = Number(score);
    if (!G.has(g)) return res.status(400).json({ error: 'invalid game' });
    if (!name || name.length < 2) return res.status(400).json({ error: 'invalid nickname' });
    if (!Number.isFinite(sc) || sc < 0 || sc > 1000000) return res.status(400).json({ error: 'invalid score' });
    const col = await ensureLeaderboard();
    if (!col) return res.status(503).json({ error: 'Database not configured' });
    const doc = { id: `lb-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, game: g, nickname: name, score: sc, createdAt: new Date().toISOString() };
    await col.insertOne(doc);
    const { _id, ...clean } = doc;
    return res.status(201).json({ entry: clean });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to submit score' });
  }
});

// Upload API -> Vercel Blob (if configured)
const memStorage = multer.memoryStorage();
const upload = multer({ storage: memStorage, limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload', basicAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(501).json({ error: 'Blob storage not configured' });
    }
    const safeName = path.basename(req.file.originalname).replace(/[^a-z0-9\.-]/gi, '_');
    const key = `projects/${Date.now()}-${safeName}`;
    const result = await put(key, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    return res.json({ url: result.url });
  } catch (e) {
    return res.status(500).json({ error: 'Upload failed' });
  }
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

// Projects CRUD
app.get('/api/projects', async (req, res) => {
  try {
    const { type } = req.query;
    const items = await dbGetProjects(type);
    res.set('Cache-Control', 'no-store');
    res.json({ projects: items });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

app.post('/api/projects', basicAuth, async (req, res) => {
  const { id, title, description, image, type } = req.body || {};
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
  const { title, description, image, type } = req.body || {};
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
    res.set('Cache-Control', 'no-store');
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Fallback endpoints for hosts blocking PUT/DELETE
app.post('/api/projects/update', basicAuth, async (req, res) => {
  try {
    const { id, title, description, image, type } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const updated = await dbUpdateProject(id, { title, description, image, type });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    res.json({ project: updated });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

app.post('/api/projects/delete', basicAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const ok = await dbDeleteProject(id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

async function importFromLocalToActiveProvider() {
  const source = readDb();
  const items = Array.isArray(source.projects) ? source.projects : [];
  const col = await ensureMongo();
  if (col) {
    let upserts = 0;
    for (const p of items) {
      const { id, type, title, description, image } = p;
      const r = await col.updateOne({ id }, { $set: { id, type, title, description, image } }, { upsert: true });
      if (r.upsertedCount || r.matchedCount) upserts++;
    }
    const count = await col.countDocuments();
    return { imported: upserts, provider: 'mongodb', total: count };
  }
  return { imported: 0, provider: 'json', total: (items || []).length };
}

app.post('/api/projects/import', basicAuth, async (req, res) => {
  try {
    const result = await importFromLocalToActiveProvider();
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to import', message: e.message });
  }
});

app.get('/api/projects/import', basicAuth, async (req, res) => {
  try {
    const result = await importFromLocalToActiveProvider();
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to import', message: e.message });
  }
});

// Secure PDF proxy
app.get('/api/pdf-proxy', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '');
    if (!rawUrl) return res.status(400).send('url required');
    let u;
    try { u = new URL(rawUrl); } catch { return res.status(400).send('invalid url'); }
    if (u.protocol !== 'https:') return res.status(400).send('https only');

    const allowList = (process.env.PDF_PROXY_ALLOWLIST || 'www.w3.org').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!allowList.includes(u.hostname.toLowerCase())) return res.status(403).send('host not allowed');

    const MAX = 25 * 1024 * 1024; // 25MB cap
    let total = 0;

    function handle(upstream) {
      const ct = String(upstream.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/pdf')) {
        res.status(415).send('not a pdf');
        upstream.destroy();
        return;
      }
      const cl = Number(upstream.headers['content-length'] || 0);
      if (cl && cl > MAX) {
        res.status(413).send('file too large');
        upstream.destroy();
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      upstream.on('data', chunk => {
        total += chunk.length;
        if (total > MAX) {
          try { res.status(413).end('file too large'); } catch {}
          upstream.destroy();
          return;
        }
        res.write(chunk);
      });
      upstream.on('end', () => res.end());
      upstream.on('error', () => { if (!res.headersSent) res.status(502).end('stream error'); });
    }

    https.get(u.toString(), (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        try {
          const ru = new URL(r.headers.location, u);
          https.get(ru.toString(), handle).on('error', () => res.status(502).send('fetch failed'));
        } catch {
          res.status(502).send('bad redirect');
        }
      } else {
        handle(r);
      }
    }).on('error', () => res.status(502).send('fetch failed'));
  } catch (e) {
    res.status(500).send('proxy error');
  }
});

module.exports = serverless(app);
