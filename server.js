const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8081;

app.use(express.static(__dirname));
app.use(express.json({ limit: '1mb' }));

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'RAC IIE.html'));
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
app.get('/api/projects', (req, res) => {
  const { type } = req.query;
  const db = readDb();
  let items = db.projects || [];
  if (type === 'flagship' || type === 'upcoming') items = items.filter(p => p.type === type);
  res.json({ projects: items });
});

app.post('/api/projects', (req, res) => {
  const { id, title, description, image, type } = req.body;
  if (!title || !description || !image || !type) return res.status(400).json({ error: 'Missing fields' });
  const db = readDb();
  const newItem = { id: id || `${type}-${Date.now()}`, title, description, image, type };
  db.projects.push(newItem);
  writeDb(db);
  res.status(201).json({ project: newItem });
});

app.put('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, image, type } = req.body;
  const db = readDb();
  const idx = db.projects.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.projects[idx] = { ...db.projects[idx], title, description, image, type: type || db.projects[idx].type };
  writeDb(db);
  res.json({ project: db.projects[idx] });
});

app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const db = readDb();
  const before = db.projects.length;
  db.projects = db.projects.filter(p => p.id !== id);
  if (db.projects.length === before) return res.status(404).json({ error: 'Not found' });
  writeDb(db);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`🚀 Rotaract Club website running on http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${__dirname}`);
});
