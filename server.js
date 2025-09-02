const express = require('express');
const path = require('path');
const fs = require('fs');
const { MongoClient, ServerApiVersion } = require('mongodb');
const multer = require('multer');
const https = require('https');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8081;

app.use(express.json({ limit: '1mb' }));

// Upload configuration
const uploadDir = path.join(__dirname, 'assets', 'images', 'projects');
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9\.-]/gi, '_');
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.has(ext)) return cb(new Error('Unsupported file type'));
    cb(null, true);
  }
});

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

// Local JSON fallback for bulletins when MongoDB is not configured
const BULL_DB_PATH = path.join(__dirname, 'data', 'bulletins.json');
function readBulletinsLocal() {
  try {
    const raw = fs.readFileSync(BULL_DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { bulletins: [] };
  }
}
function writeBulletinsLocal(db) {
  fs.mkdirSync(path.dirname(BULL_DB_PATH), { recursive: true });
  fs.writeFileSync(BULL_DB_PATH, JSON.stringify(db, null, 2));
}

// MongoDB setup
let mongoClient = null;
let mongoDb = null;
let projectsCol = null;
let highlightsCol = null;
let powerStonesCol = null;
let bulletinsCol = null;

async function ensureMongo() {
  if (projectsCol) return projectsCol;
  const uri = process.env.MONGODB_URI || (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('mongodb') ? process.env.DATABASE_URL : null);
  if (!uri) return null;
  mongoClient = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
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

async function ensureHighlights() {
  if (!mongoDb) {
    const col = await ensureMongo();
    if (!col) return null;
  }
  if (!highlightsCol) {
    highlightsCol = mongoDb.collection('highlights');
    try {
      await highlightsCol.createIndex({ id: 1 }, { unique: true });
      await highlightsCol.createIndex({ order: 1 });
    } catch (e) {}
  }
  return highlightsCol;
}

async function ensurePowerStones() {
  if (!mongoDb) {
    const col = await ensureMongo();
    if (!col) return null;
  }
  if (!powerStonesCol) {
    powerStonesCol = mongoDb.collection('powerstones');
    try {
      await powerStonesCol.createIndex({ id: 1 }, { unique: true });
      await powerStonesCol.createIndex({ slot: 1 }, { unique: true });
    } catch (e) {}
  }
  return powerStonesCol;
}

async function ensureBulletins() {
  if (!mongoDb) {
    const col = await ensureMongo();
    if (!col) return null;
  }
  if (!bulletinsCol) {
    bulletinsCol = mongoDb.collection('bulletins');
    try {
      await bulletinsCol.createIndex({ id: 1 }, { unique: true });
      await bulletinsCol.createIndex({ lang: 1, date: -1 });
      await bulletinsCol.createIndex({ createdAt: -1 });
    } catch (e) {}
  }
  return bulletinsCol;
}

async function dbGetProjects(type) {
  const allowed = new Set(['flagship','existing','upcoming']);
  const col = await ensureMongo();
  if (col) {
    const query = allowed.has(type) ? { type } : {};
    const items = await col.find(query).sort({ title: 1 }).toArray();
    return items.map(({ id, type, title, description, image }) => ({ id, type, title, description, image }));
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'RAC IIE.html'));
});

// Admin page (HTML only). Publicly viewable; admin actions stay protected via API.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Direct access to admin.html
app.get('/admin.html', (req, res) => {
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

// Highlights API (Mongo-backed, with filesystem fallback)
app.get('/api/highlights', async (req, res) => {
  try {
    const col = await ensureHighlights();
    if (col) {
      const docs = await col.find({}).sort({ order: 1, title: 1 }).project({ _id: 0, src: 1 }).toArray();
      const images = docs.map(d => d.src).filter(Boolean);
      if (images.length) return res.json({ images });
    }
    const galleryDir = path.join(__dirname, 'assets', 'images', 'gallery');
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
    const files = fs.existsSync(galleryDir) ? fs.readdirSync(galleryDir) : [];
    const images = files.filter(f => allowed.has(path.extname(f).toLowerCase())).map(f => `assets/images/gallery/${f}`);
    return res.json({ images });
  } catch (e) {
    return res.status(500).json({ images: [], error: e.message });
  }
});

// Admin: list highlights with full data
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

// Admin: create a new highlight
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

// Admin: update highlight
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

// Admin: delete highlight
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

// Power Stones API
app.get('/api/power-stones', async (req, res) => {
  try {
    const col = await ensurePowerStones();
    if (col) {
      const docs = await col.find({}).sort({ slot: 1 }).project({ _id: 0, id: 1, slot: 1, src: 1, title: 1 }).toArray();
      if (docs.length) return res.json({ stones: docs });
    }
    // Fallback to defaults
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

// Bulletins API
function monthKey(d) {
  const s = String(d || '').slice(0, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return '';
  return s.slice(0, 7);
}

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

    // JSON fallback (no MongoDB)
    const local = readBulletinsLocal();
    const all = (local.bulletins || [])
      .filter(b => (b.lang || 'ta').toLowerCase() === lang)
      .sort((a, b) => {
        const da = String(a.date || '').slice(0, 10);
        const db = String(b.date || '').slice(0, 10);
        if (da === db) return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        return db.localeCompare(da);
      });
    if (all.length) {
      const latest = all[0];
      const archives = all.slice(1).map(({ id, title, date, pdf, lang }) => ({ id, title, date, pdf, lang }));
      return res.json({ latest, archives });
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

// Grouped bulletins by month across all languages (public)
app.get('/api/bulletins/grouped', async (req, res) => {
  try {
    const col = await ensureBulletins();
    if (col) {
      const items = await col.find({}).sort({ date: -1, createdAt: -1 }).project({ _id: 0 }).toArray();
      const groups = {};
      for (const b of items) {
        const mk = monthKey(b.date);
        if (!mk) continue;
        if (!groups[mk]) groups[mk] = [];
        groups[mk].push({ id: b.id, lang: b.lang, title: b.title, date: b.date, pdf: b.pdf });
      }
      const months = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(m => ({ month: m, items: groups[m] }));
      return res.json({ months });
    }
    const local = readBulletinsLocal();
    const groups = {};
    for (const b of (local.bulletins || [])) {
      const mk = monthKey(b.date);
      if (!mk) continue;
      if (!groups[mk]) groups[mk] = [];
      groups[mk].push({ id: b.id, lang: b.lang, title: b.title, date: b.date, pdf: b.pdf });
    }
    const months = Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(m => ({ month: m, items: groups[m] }));
    return res.json({ months });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load grouped bulletins' });
  }
});

app.get('/api/bulletins/admin', basicAuth, async (req, res) => {
  try {
    const col = await ensureBulletins();
    if (!col) {
      const local = readBulletinsLocal();
      const items = (local.bulletins || []).slice().sort((a, b) => {
        const da = String(a.date || '').slice(0, 10);
        const db = String(b.date || '').slice(0, 10);
        if (da === db) return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        return db.localeCompare(da);
      });
      return res.json({ bulletins: items });
    }
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
    const nid = id || `${lang}-${Date.now()}`;
    const doc = { id: nid, lang: lang.toLowerCase(), title: title || '', pdf: pdf.trim(), date: date || new Date().toISOString().slice(0,10), createdAt: new Date().toISOString() };
    if (!col) {
      const local = readBulletinsLocal();
      const arr = Array.isArray(local.bulletins) ? local.bulletins : [];
      const idx = arr.findIndex(b => b.id === nid);
      if (idx !== -1) arr[idx] = doc; else arr.push(doc);
      writeBulletinsLocal({ bulletins: arr });
      return res.status(201).json({ bulletin: doc });
    }
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
    if (!col) {
      const local = readBulletinsLocal();
      const before = (local.bulletins || []).length;
      const arr = (local.bulletins || []).filter(b => b.id !== id);
      writeBulletinsLocal({ bulletins: arr });
      if (arr.length === before) return res.status(404).json({ error: 'Not found' });
      return res.status(204).end();
    }
    const { deletedCount } = await col.deleteOne({ id });
    if (!deletedCount) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete bulletin' });
  }
});

// Upload API
app.post('/api/upload', basicAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = ['assets', 'images', 'projects', req.file.filename].join('/');
    return res.json({ url });
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

// Import projects from local JSON into the active provider (MongoDB if configured)
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

// Secure PDF proxy to bypass X-Frame-Options on external hosts while limiting scope
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

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`🚀 Rotaract Club website running on http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${__dirname}`);
  (async () => {
    try {
      const col = await ensureMongo();
      if (col) {
        const count = await col.countDocuments();
        if (count === 0) {
          const source = readDb();
          const items = Array.isArray(source.projects) ? source.projects : [];
          for (const p of items) {
            const { id, type, title, description, image } = p;
            await col.updateOne({ id }, { $set: { id, type, title, description, image } }, { upsert: true });
          }
          const newCount = await col.countDocuments();
          console.log(`Seeded ${newCount} projects into MongoDB`);
        }
        // Seed highlights if empty from filesystem gallery
        const hcol = await ensureHighlights();
        if (hcol) {
          const hcount = await hcol.countDocuments();
          if (hcount === 0) {
            const galleryDir = path.join(__dirname, 'assets', 'images', 'gallery');
            const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
            const files = fs.existsSync(galleryDir) ? fs.readdirSync(galleryDir) : [];
            const images = files.filter(f => allowed.has(path.extname(f).toLowerCase())).map((f, i) => ({ id: `hl-${i}-${f}`, src: `assets/images/gallery/${f}`, title: f, order: i }));
            if (images.length) await hcol.insertMany(images, { ordered: false }).catch(() => {});
            const seeded = await hcol.countDocuments();
            console.log(`Highlights seeded: ${seeded}`);
          }
        }
        // Seed power stones if empty with defaults
        const pscol = await ensurePowerStones();
        if (pscol) {
          const pscount = await pscol.countDocuments();
          if (pscount === 0) {
            const defaults = [
              { slot: 1, id: 'ps-1', src: 'https://placehold.co/600x400/eab308/ffffff?text=Glory', title: 'Glory' },
              { slot: 2, id: 'ps-2', src: 'https://placehold.co/600x400/22c55e/ffffff?text=Conquest', title: 'Conquest' },
              { slot: 3, id: 'ps-3', src: 'https://placehold.co/600x400/8b5cf6/ffffff?text=Feast', title: 'Feast' },
              { slot: 4, id: 'ps-4', src: 'https://placehold.co/600x400/3b82f6/ffffff?text=Alliance', title: 'Alliance' },
              { slot: 5, id: 'ps-5', src: 'https://placehold.co/600x400/ef4444/ffffff?text=Council', title: 'Council' },
              { slot: 6, id: 'ps-6', src: 'https://placehold.co/600x400/14b8a6/ffffff?text=Valor', title: 'Valor' }
            ];
            await pscol.insertMany(defaults, { ordered: true }).catch(() => {});
            const newCount = await pscol.countDocuments();
            console.log(`Power Stones seeded: ${newCount}`);
          }
        }
        // Seed bulletins: ensure current month and previous month for all languages
        const bcol = await ensureBulletins();
        if (bcol) {
          const now = new Date();
          const curr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
          const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
          const iso = (d)=> new Date(d).toISOString().slice(0,10);
          const langs = [
            { code:'ta', title:'தமிழ் பதிப்பு' },
            { code:'en', title:'English Edition' },
            { code:'kn', title:'Kannada Edition' },
            { code:'ml', title:'Malayalam Edition' },
            { code:'te', title:'Telugu Edition' },
          ];
          let inserted = 0;
          for (const when of [curr, prev]) {
            for (const l of langs) {
              const dateStr = iso(when);
              const id = `${l.code}-${dateStr.slice(0,7)}`;
              const exists = await bcol.findOne({ id });
              if (!exists) {
                const doc = { id, lang: l.code, title: l.title, pdf: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', date: dateStr, createdAt: new Date().toISOString() };
                await bcol.insertOne(doc).catch(()=>{});
                inserted++;
              }
            }
          }
          if (inserted) console.log(`Bulletins ensured/seeded: +${inserted}`);
        }
      }
    } catch (e) {
      console.error('Seeding/migration skipped due to error:', e.message);
    }
  })();
});
