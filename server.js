const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8081;

// Serve static files from the current directory
app.use(express.static(__dirname));

// Route for the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'RAC IIE.html'));
});

// API: list gallery images
app.get('/api/gallery', (req, res) => {
    const galleryDir = path.join(__dirname, 'assets', 'images', 'gallery');
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

    fs.readdir(galleryDir, (err, files) => {
        if (err) {
            console.error('Error reading gallery directory:', err.message);
            return res.status(500).json({ images: [] });
        }
        const images = files
            .filter((f) => allowed.has(path.extname(f).toLowerCase()))
            .map((f) => `assets/images/gallery/${f}`);
        res.json({ images });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Rotaract Club website running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from: ${__dirname}`);
});
