const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Postgres connection (Locus auto-injects DATABASE_URL from addon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize table on startup
async function initDb() {
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
    console.error('DB init error:', err.message);
  }
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Hello from Locus PaaS!',
    service: process.env.SERVICE_ID || 'unknown',
    version: '2.0.0',
    endpoints: ['/register', '/names', '/health'],
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
    const result = await pool.query(
      'INSERT INTO names (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );
    res.status(201).json({ 
      message: 'Registered successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Failed to register name' });
  }
});

// Get all names
app.get('/names', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, created_at FROM names ORDER BY created_at DESC');
    res.json({ 
      count: result.rows.length,
      names: result.rows 
    });
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
    pool.end();
    console.log('Server closed');
    process.exit(0);
  });
});
