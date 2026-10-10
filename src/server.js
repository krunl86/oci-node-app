require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { loadSecrets } = require('./secrets');

const app = express();
const PORT = process.env.PORT || 3000;
// VERSION is written into each release zip by the build pipeline
const versionFile = path.join(__dirname, '..', 'VERSION');
const APP_VERSION = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : 'local';
let secretsSource = 'env';

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Sample in-memory data
const books = [
  { id: 1, title: 'Ramayana', author: 'Valmiki', year: -500 },
  { id: 2, title: 'Mahabharata', author: 'Vyasa', year: -400 },
  { id: 3, title: 'Bhagavad Gita', author: 'Vyasa', year: -200 },
];

// 1. Health check (also useful for OCI load balancer / container probes)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cloud: 'oci',
    version: APP_VERSION,
    secretsSource,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 2. List all books
app.get('/api/books', (req, res) => {
  res.json({ count: books.length, data: books });
});

// 3. Get a single book by id
app.get('/api/books/:id', (req, res) => {
  const book = books.find((b) => b.id === Number(req.params.id));
  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }
  res.json(book);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

async function start() {
  secretsSource = await loadSecrets();
  const server = app.listen(PORT, () =>
    console.log(`Server ${APP_VERSION} running on port ${PORT} (secrets: ${secretsSource})`)
  );
  // systemd sends SIGTERM on stop/restart during a deployment
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = app;
