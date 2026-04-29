require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors = require('cors');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3001;

// ===== 🔍 ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ (ОБЯЗАТЕЛЬНО) =====
const requiredEnv = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET', 
  'DISCORD_BOT_TOKEN',
  'DISCORD_REDIRECT_URI',
  'SESSION_SECRET'
];

const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: Отсутствуют переменные окружения:');
  missing.forEach(key => console.error(`   • ${key}`));
  console.error('\n💡 РЕШЕНИЕ:');
  console.error('   1. Зайди в панель хостинга (Railway/Render/Vercel)');
  console.error('   2. Открой раздел "Variables" или "Environment"');
  console.error('   3. Добавь все переменные из таблицы ниже:');
  console.error('\n   Key                          | Value');
  console.error('   -----------------------------|----------------------------------');
  console.error('   DISCORD_CLIENT_ID            | 1107807820604248126');
  console.error('   DISCORD_CLIENT_SECRET        | [твой_секрет_из_Discord_Portal]');
  console.error('   DISCORD_BOT_TOKEN            | [твой_токен_бота]');
  console.error('   DISCORD_REDIRECT_URI         | https://твой-сайт.netlify.app/api/auth/callback');
  console.error('   SESSION_SECRET               | любой_длинный_секретный_ключ_2024');
  console.error('   FRONTEND_URL                 | https://твой-сайт.netlify.app');
  console.error('   PORT                         | 3001');
  console.error('   NODE_ENV                     | production');
  console.error('\n   После добавления — перезапусти сервер (Redeploy).');
  process.exit(1);
}

// ===== MIDDLEWARE =====
app.use(cors({ 
  origin: [
    'http://localhost:3000',
    'http://localhost:3001', 
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true 
}));
app.use(express.json());
app.use(express.static('../frontend'));

// ===== SESSION =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_change_in_production_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: parseInt(process.env.SESSION_COOKIE_MAX_AGE) || 604800000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));
app.use(passport.initialize());
app.use(passport.session());

// ===== PASSPORT DISCORD =====
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

// ===== DISCORD BOT CLIENT =====
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

bot.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log('🤖 Synth Bot online'))
  .catch(err => {
    console.error('❌ Bot login error:', err.message);
    // Не завершаем процесс — сервер может работать без бота для некоторых эндпоинтов
  });

// ===== КЭШ И ПОВТОРНЫЕ ЗАПРОСЫ =====
const guildsCache = new Map();
const CACHE_TTL = 60000; // 60 секунд

async function fetchWithRetry(url, headers, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await axios.get(url, { headers });
    } catch (err) {
      if (err.response?.status === 429 && err.response.data?.retry_after) {
        const wait = err.response.data.retry_after * 1000 + 50;
        console.log(`⏳ Rate limit, ждём ${wait}ms... (${attempt+1}/${maxRetries})`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ===== API ROUTES =====

// 1. Start OAuth
app.get('/api/auth/discord', passport.authenticate('discord'));

// 2. OAuth Callback
app.get('/api/auth/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/dashboard.html`);
  }
);

// 3. Get current user
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

// 4. Logout
app.get('/api/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

// 5. Get user's servers WITH BOT INSTALLED (ОПТИМИЗИРОВАННЫЙ - БЫСТРЫЙ)
app.get('/api/user/servers', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const userId = req.user.id;
  const now = Date.now();
  
  // 🔹 Проверяем кэш
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
    
    const checks = manageable.map(async (guild) => {
      let botGuild = bot.guilds.cache.get(guild.id);
      
      if (!botGuild) {
        botGuild = await bot.guilds.fetch(guild.id).catch(() => null);
      }
      
      if (botGuild) {
        const icon = guild.icon 
          ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
          : null;
        
        const memberCount = botGuild.memberCount || botGuild.approximateMemberCount || 0;
        const onlineCount = botGuild.approximatePresenceCount || 0;

        return {
          id: guild.id,
          name: guild.name,
          icon: icon,
          owner: guild.owner,
          permissions: guild.permissions,
          botInstalled: true,
          memberCount: memberCount,
          onlineCount: onlineCount
        };
      }
      return null;
    });

    const results = await Promise.all(checks);
    const validServers = results.filter(s => s !== null);
    
    guildsCache.set(userId, { servers: validServers, timestamp: now });
    
    console.log(`✅ Returned ${validServers.length} servers for ${userId}`);
    res.json(validServers);
    
  } catch (err) {
    console.error('❌ Error fetching guilds:', err.response?.data || err.message);
    
    if (err.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Discord API rate limit. Please wait and refresh.',
        retryAfter: err.response.data?.retry_after 
      });
    }
    
    res.status(500).json({ error: 'Failed to fetch servers' });
  }
});

// 6. Get server config
app.get('/api/servers/:guildId/config', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { guildId } = req.params;
  const guild = bot.guilds.cache.get(guildId);
  
  if (!guild) return res.status(404).json({ error: 'Bot not in this server' });
  
  res.json({
    guildId,
    guildName: guild.name,
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

// 7. Save server config
app.post('/api/servers/:guildId/config', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { guildId } = req.params;
  const updates = req.body;
  const guild = bot.guilds.cache.get(guildId);
  
  if (!guild) return res.status(404).json({ error: 'Bot not in this server' });
  
  console.log(`📝 Config updated for ${guildId}:`, updates);
  
  res.json({ success: true, message: 'Settings saved' });
});

// 8. Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: bot.isReady(),
    servers: bot.guilds.cache.size,
    env: {
      CLIENT_ID_SET: !!process.env.DISCORD_CLIENT_ID,
      REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
      FRONTEND_URL: process.env.FRONTEND_URL
    }
  });
});

// ===== START SERVER (УНИВЕРСАЛЬНЫЙ) =====

// 🔍 Логирование переменных окружения (работает везде)
const logEnv = () => {
  console.log('🔧 Environment check:');
  console.log(`   • DISCORD_CLIENT_ID: ${process.env.DISCORD_CLIENT_ID ? '✅' : '❌'}`);
  console.log(`   • DISCORD_CLIENT_SECRET: ${process.env.DISCORD_CLIENT_SECRET ? '✅' : '❌'}`);
  console.log(`   • DISCORD_BOT_TOKEN: ${process.env.DISCORD_BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`   • DISCORD_REDIRECT_URI: ${process.env.DISCORD_REDIRECT_URI || '❌'}`);
  console.log(`   • SESSION_SECRET: ${process.env.SESSION_SECRET ? '✅' : '❌'}`);
  console.log(`   • FRONTEND_URL: ${process.env.FRONTEND_URL || '❌'}`);
  console.log(`   • VERCEL: ${process.env.VERCEL ? '✅ (Serverless)' : '❌ (Traditional)'}`);
  console.log(`   • NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
};

// 🚀 Запуск в традиционном режиме (Railway, Render, локально)
if (!process.env.VERCEL) {
  logEnv();
  
  app.listen(PORT, () => {
    console.log(`\n🚀 Backend running on port ${PORT}`);
    console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
    console.log(`\n💡 Tip: On Vercel, this block is skipped — using serverless handler instead.`);
  });
} 
// ☁️ Экспорт для Vercel Serverless (app.listen() не используется)
else {
  logEnv();
  console.log(`\n☁️ Running on Vercel Serverless — using serverless-http handler`);
  console.log(`🔗 Health check: ${process.env.VERCEL_URL || 'https://твой-проект.vercel.app'}/api/health`);
}

// 📦 Экспорт приложения для serverless-http (Vercel)
// Этот код не мешает традиционному запуску
module.exports = app;
