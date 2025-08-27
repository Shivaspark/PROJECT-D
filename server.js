const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8081;

// Serve static files from the current directory
app.use(express.static(__dirname));

// Route for the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'RAC IIE.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Rotaract Club website running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from: ${__dirname}`);
});
