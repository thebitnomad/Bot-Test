const express = require('express');
const { Pool } = require('pg');
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestWaWebVersion } = require("@whiskeysockets/baileys");
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');
const simpleGit = require('simple-git');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Store active pairing sessions
const activePairingSessions = new Map();
const GITHUB_REPO_URL = 'https://github.com/thebitnomad/9bot';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;

// Clone and setup local repo
const tempDir = path.join(__dirname, 'temp-repo');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const git = simpleGit(tempDir);

// Initialize database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        heroku_app VARCHAR(255),
        connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deployed_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'pending'
      )
    `);
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database init error:', error);
  }
}

// Routes

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Toxic-MD Pairing API', 
    version: '1.0',
    endpoints: [
      '/pair - Start pairing',
      '/deploy/:userId - Trigger deployment',
      '/status/:userId - Check status',
      '/sessions - List all sessions'
    ]
  });
});

// Start pairing process
app.post('/pair', async (req, res) => {
  try {
    const { phoneNumber, userId } = req.body;
    
    if (!phoneNumber || !userId) {
      return res.status(400).json({ error: 'Phone number and user ID required' });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User ID already exists' });
    }

    const sessionId = `toxic_${userId}_${Date.now()}`;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);

    // Create session directory
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const { version } = await fetchLatestWaWebVersion();
    
    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: 'silent' })),
      },
      version,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' })
    });

    // Request pairing code
    const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
    
    // Store session info
    activePairingSessions.set(sessionId, {
      sock,
      saveCreds,
      state,
      sessionPath,
      userId,
      phoneNumber,
      connected: false
    });

    // Save user to database
    await pool.query(
      'INSERT INTO users (user_id, phone_number, session_id, status) VALUES ($1, $2, $3, $4)',
      [userId, phoneNumber, sessionId, 'pairing']
    );

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const session = activePairingSessions.get(sessionId);
      if (!session) return;

      if (update.connection === 'open') {
        console.log(`✅ User ${userId} connected successfully`);
        session.connected = true;
        
        // Update database
        await pool.query(
          'UPDATE users SET status = $1, connected_at = $2 WHERE user_id = $3',
          ['connected', new Date(), userId]
        );

        // Save credentials to GitHub and deploy
        await saveCredsToGitHubAndDeploy(sessionId, userId);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    res.json({ 
      success: true, 
      pairingCode: code,
      sessionId,
      message: 'Enter this code in WhatsApp Linked Devices'
    });

  } catch (error) {
    console.error('❌ Pairing error:', error);
    res.status(500).json({ error: 'Failed to generate pairing code' });
  }
});

// Save credentials to GitHub and trigger deployment
async function saveCredsToGitHubAndDeploy(sessionId, userId) {
  try {
    const session = activePairingSessions.get(sessionId);
    if (!session) return;

    console.log(`🚀 Starting deployment for user: ${userId}`);

    // Clone the repo
    if (!fs.existsSync(path.join(tempDir, '.git'))) {
      await git.clone(`https://${GITHUB_TOKEN}@github.com/thebitnomad/9bot.git`, '.');
    } else {
      await git.pull();
    }

    // Copy session files to repo
    const sessionFiles = fs.readdirSync(session.sessionPath);
    const repoSessionPath = path.join(tempDir, 'Session');
    
    if (!fs.existsSync(repoSessionPath)) {
      fs.mkdirSync(repoSessionPath, { recursive: true });
    }

    // Copy all session files
    for (const file of sessionFiles) {
      const sourcePath = path.join(session.sessionPath, file);
      const destPath = path.join(repoSessionPath, file);
      fs.copyFileSync(sourcePath, destPath);
    }

    // Create app.json for this user
    const appJson = {
      name: `toxic-md-${userId}`,
      description: "Toxic-MD WhatsApp Bot",
      repository: GITHUB_REPO_URL,
      env: {
        USER_ID: {
          value: userId,
          required: true
        }
      },
      addons: [
        {
          plan: "heroku-postgresql"
        }
      ],
      buildpacks: [
        { url: "heroku/nodejs" },
        { url: "https://github.com/clhuang/heroku-buildpack-webp-binaries.git" },
        { url: "https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest" }
      ]
    };

    fs.writeFileSync(path.join(tempDir, 'app.json'), JSON.stringify(appJson, null, 2));

    // Commit and push to GitHub
    await git.add('.');
    await git.commit(`Add session for user ${userId}`);
    await git.push('origin', 'main');

    console.log(`✅ Credentials saved to GitHub for user: ${userId}`);

    // Deploy to Heroku
    await deployToHeroku(userId);

  } catch (error) {
    console.error('❌ GitHub save error:', error);
  }
}

// Deploy to Heroku
async function deployToHeroku(userId) {
  try {
    const appName = `toxic-md-${userId}-${Date.now()}`.toLowerCase().substring(0, 30);

    // Create Heroku app
    const createAppResponse = await axios.post(
      'https://api.heroku.com/apps',
      { name: appName },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Configure environment
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      {
        USER_ID: userId
      },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Connect to GitHub and deploy
    await axios.post(
      `https://api.heroku.com/apps/${appName}/builds`,
      {
        source_blob: {
          url: `https://github.com/thebitnomad/9bot/tarball/main/`,
          version: "main"
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${HEROKU_API_KEY}`,
          'Accept': 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Update database
    await pool.query(
      'UPDATE users SET heroku_app = $1, deployed_at = $2, status = $3 WHERE user_id = $4',
      [appName, new Date(), 'deployed', userId]
    );

    console.log(`✅ Bot deployed for user ${userId}: ${appName}`);

    // Cleanup: Remove session from GitHub after deployment
    setTimeout(() => cleanupGitHubSession(userId), 60000);

  } catch (error) {
    console.error('❌ Heroku deployment error:', error);
    await pool.query(
      'UPDATE users SET status = $1 WHERE user_id = $2',
      ['deployment_failed', userId]
    );
  }
}

// Cleanup GitHub session
async function cleanupGitHubSession(userId) {
  try {
    // Reset repo to remove session files
    await git.reset(['--hard', 'HEAD~1']); // Revert last commit
    await git.push('origin', 'main', ['--force']);
    
    console.log(`✅ Cleaned up GitHub session for user: ${userId}`);
  } catch (error) {
    console.error('❌ GitHub cleanup error:', error);
  }
}

// Check deployment status
app.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// List all sessions
app.get('/sessions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT user_id, phone_number, heroku_app, status, connected_at, deployed_at FROM users ORDER BY connected_at DESC'
    );
    
    res.json({ 
      total: result.rows.length,
      sessions: result.rows 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// Manual deployment trigger
app.post('/deploy/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const session = Array.from(activePairingSessions.values())
      .find(s => s.userId === userId && s.connected);

    if (!session) {
      return res.status(404).json({ error: 'No active connected session found' });
    }

    await saveCredsToGitHubAndDeploy(session.sessionId, userId);
    res.json({ success: true, message: 'Deployment triggered' });

  } catch (error) {
    res.status(500).json({ error: 'Deployment failed' });
  }
});

// Start server
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`🚀 Toxic-MD Pairing API running on port ${port}`);
});
