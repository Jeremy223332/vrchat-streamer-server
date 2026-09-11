import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS for VRChat / Unity players
app.use(cors());

// Serve HTML pages (caster.html, tv.html, etc.) directly from the project root
app.use(express.static(__dirname));

// Serve the live stream HLS directory
app.use('/live', express.static(path.join(__dirname, 'live')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'caster.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
