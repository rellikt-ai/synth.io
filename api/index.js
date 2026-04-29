// api/index.js — точка входа для Vercel
const express = require('express');
const serverless = require('serverless-http');
require('dotenv').config();

// ===== ИМПОРТЫ =====
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors = require('cors');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();

// ===== ПРОВЕРКА ПЕРЕМЕННЫХ =====
const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_REDIRECT_URI', 'SESSION_SECRET'];
const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ Missing env vars:', missing);
  return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
}

// ===== MIDDLEWARE =====
app.use(cors({ 
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    process.env.FRONTEND_URL,
    /\.vercel\.app$/
  ].filter(Boolean),
  credentials: true 
}));
app.use(express.json());

// Статика: в серверлесс лучше отдавать только через CDN, но для демо оставим
// app.use(express.static('../frontend')); // ← закомментировать, т.к. путь не сработает

// ===== SESSION (с адаптацией для серверлесс) =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 604800000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));
app.use(passport.initialize());
app.use(passport.session());

// ===== PASSPORT =====
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_REDIRECT_URI,
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  profile.accessToken = accessToken;
  return done(null, profile);
}));
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ===== DISCORD BOT (ОПЦИОНАЛЬНО — может не работать в серверлесс) =====
// В серверлесс-функциях бот может отключаться между вызовами.
// Для надёжности лучше вынести бота в отдельный сервис (Railway/Render).
let bot = null;
try {
  bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  bot.login(process.env.DISCORD_BOT_TOKEN).catch(err => console.error('Bot login error:', err.message));
} catch (e) {
  console.warn('⚠️ Bot client not initialized (serverless environment)');
}

// ===== КЭШ (в памяти — сбрасывается между вызовами) =====
const guildsCache = new Map();
const CACHE_TTL = 60000;

async function fetchWithRetry(url, headers, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await axios.get(url, { headers });
    } catch (err) {
      if (err.response?.status === 429 && err.response.data?.retry_after) {
        await new Promise(res => setTimeout(res, err.response.data.retry_after * 1000 + 50));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ===== API ROUTES =====
app.get('/api/auth/discord', passport.authenticate('discord'));

app.get('/api/auth/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    const frontendUrl = process.env.FRONTEND_URL || 'https://synth-bot.vercel.app';
    res.redirect(`${frontendUrl}/dashboard.html`);
  }
);

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ authenticated: false });
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      discriminator: req.user.discriminator,
      avatar: req.user.avatar,
      globalName: req.user.globalName
    }
  });
});

app.get('/api/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

app.get('/api/user/servers', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const userId = req.user.id;
  const now = Date.now();
  const cached = guildsCache.get(userId);
  
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    return res.json(cached.servers);
  }
  
  try {
    const response = await fetchWithRetry(
      'https://discord.com/api/users/@me/guilds',
      { Authorization: `Bearer ${req.user.accessToken}` }
    );
    const userGuilds = response.data;
    const manageable = userGuilds.filter(g => (parseInt(g.permissions) & 0x20) === 0x20);
    
    const serversWithBot = [];
    // В серверлесс бот может быть не готов — пропускаем проверку, возвращаем все сервера с правами
    for (const guild of manageable) {
      const icon = guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null;
      serversWithBot.push({
        id: guild.id,
        name: guild.name,
        icon,
        owner: guild.owner,
        permissions: guild.permissions,
        botInstalled: true, // ← предполагаем, что бот есть (проверка на фронте)
        memberCount: 0,
        onlineCount: 0
      });
    }
    
    guildsCache.set(userId, { servers: serversWithBot, timestamp: now });
    res.json(serversWithBot);
  } catch (err) {
    console.error('Error fetching guilds:', err.message);
    res.status(500).json({ error: 'Failed to fetch servers' });
  }
});

app.get('/api/servers/:guildId/config', (req, res) => {
  // Демо-конфиг
  res.json({
    guildId: req.params.guildId,
    guildName: 'Server',
    prefix: '!',
    modules: {
      embedBuilder: { enabled: true, allowGif: false },
      tickets: { enabled: true, allowGif: false },
      clear: { enabled: true },
      autoGiveRole: { enabled: false, roleId: null },
      inviteLogger: { enabled: false },
      chatterMetrics: { enabled: false }
    }
  });
});

app.post('/api/servers/:guildId/config', (req, res) => {
  console.log('Config updated:', req.params.guildId, req.body);
  res.json({ success: true, message: 'Settings saved' });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: bot?.isReady() || false,
    env: {
      CLIENT_ID_SET: !!process.env.DISCORD_CLIENT_ID,
      REDIRECT_URI: process.env.DISCORD_REDIRECT_URI
    }
  });
});

// ===== ЭКСПОРТ ДЛЯ VERCEL (вместо app.listen) =====
module.exports.handler = serverless(app);
