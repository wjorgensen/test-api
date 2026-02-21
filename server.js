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

// Redis connection (if REDIS_URL is set)
let redis = null;
let redisConnected = false;
if (process.env.REDIS_URL) {
  const Redis = require('ioredis');
  redis = new Redis(process.env.REDIS_URL);
  redis.on('connect', () => {
    console.log('Redis connected');
    redisConnected = true;
  });
  redis.on('error', (err) => {
    console.error('Redis error:', err.message);
    redisConnected = false;
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
    version: '3.0.0',
    storage: useInMemory ? 'in-memory' : 'postgres',
    redis: redisConnected ? 'connected' : (process.env.REDIS_URL ? 'disconnected' : 'not configured'),
    endpoints: ['POST /register', 'GET /names', 'GET /health', 'GET /redis/ping', 'POST /redis/set', 'GET /redis/get/:key', 'GET /redis/incr/:key'],
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

// ========== REDIS ENDPOINTS ==========

// Redis ping test
app.get('/redis/ping', async (req, res) => {
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured', hint: 'REDIS_URL env var not set' });
  }
  try {
    const pong = await redis.ping();
    res.json({ success: true, response: pong, connected: redisConnected });
  } catch (err) {
    res.status(500).json({ error: 'Redis ping failed', message: err.message });
  }
});

// Redis set key
app.post('/redis/set', async (req, res) => {
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }
  const { key, value, ttl } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key and value are required' });
  }
  try {
    if (ttl) {
      await redis.set(key, value, 'EX', ttl);
    } else {
      await redis.set(key, value);
    }
    res.json({ success: true, key, value, ttl: ttl || null });
  } catch (err) {
    res.status(500).json({ error: 'Redis set failed', message: err.message });
  }
});

// Redis get key
app.get('/redis/get/:key', async (req, res) => {
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }
  try {
    const value = await redis.get(req.params.key);
    res.json({ key: req.params.key, value, exists: value !== null });
  } catch (err) {
    res.status(500).json({ error: 'Redis get failed', message: err.message });
  }
});

// Redis increment (useful for counters)
app.get('/redis/incr/:key', async (req, res) => {
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }
  try {
    const newValue = await redis.incr(req.params.key);
    res.json({ key: req.params.key, value: newValue });
  } catch (err) {
    res.status(500).json({ error: 'Redis incr failed', message: err.message });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DATABASE_URL: ${process.env.DATABASE_URL ? 'set' : 'not set'}`);
  console.log(`REDIS_URL: ${process.env.REDIS_URL ? 'set' : 'not set'}`);
  await initDb();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    if (pool) pool.end();
    if (redis) redis.disconnect();
    console.log('Server closed');
    process.exit(0);
  });
});
