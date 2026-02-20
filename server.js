const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// In-memory store (fallback when no DATABASE_URL)
let inMemoryNames = [];
let useInMemory = !process.env.DATABASE_URL;

// Postgres connection (if DATABASE_URL is set)
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// Initialize table on startup
async function initDb() {
  if (useInMemory) {
    console.log('Using in-memory storage (no DATABASE_URL)');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS names (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('DB init error, falling back to in-memory:', err.message);
    useInMemory = true;
  }
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Hello from Locus PaaS!',
    service: process.env.SERVICE_ID || 'unknown',
    version: '2.0.0',
    storage: useInMemory ? 'in-memory' : 'postgres',
    endpoints: ['POST /register', 'GET /names', 'GET /health'],
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Register a name
app.post('/register', async (req, res) => {
  const { name } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  
  try {
    if (useInMemory) {
      const entry = { id: inMemoryNames.length + 1, name, created_at: new Date().toISOString() };
      inMemoryNames.push(entry);
      return res.status(201).json({ message: 'Registered successfully', data: entry });
    }
    
    const result = await pool.query(
      'INSERT INTO names (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );
    res.status(201).json({ message: 'Registered successfully', data: result.rows[0] });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Failed to register name' });
  }
});

// Get all names
app.get('/names', async (req, res) => {
  try {
    if (useInMemory) {
      return res.json({ count: inMemoryNames.length, storage: 'in-memory', names: inMemoryNames });
    }
    
    const result = await pool.query('SELECT id, name, created_at FROM names ORDER BY created_at DESC');
    res.json({ count: result.rows.length, storage: 'postgres', names: result.rows });
  } catch (err) {
    console.error('Names error:', err.message);
    res.status(500).json({ error: 'Failed to fetch names' });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDb();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    if (pool) pool.end();
    console.log('Server closed');
    process.exit(0);
  });
});
