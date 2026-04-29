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

// 🔧 ВАЖНО ДЛЯ VERCEL: доверяй прокси для корректной работы куки/сессий
app.set('trust proxy', 1);

// ===== 🔍 ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ =====
const requiredEnv = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_REDIRECT_URI',
  'SESSION_SECRET'
];

const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ MISSING ENV VARS:', missing);
  console.error('💡 Добавь их в Vercel → Settings → Environment Variables');
  // Не завершаем процесс — для отладки в серверлесс
}

// ===== 🌐 MIDDLEWARE =====
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://synth-io.vercel.app',
    'https://synth-io-rellikt-ais-projects.vercel.app',
    /\.vercel\.app$/
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===== 🔐 SESSION (ИСПРАВЛЕНО ДЛЯ VERCEL) =====
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_change_in_production_2024',
  name: 'synth.sid',
  resave: false,
  saveUninitialized: false,
  proxy: true, // 🔧 Важно для Vercel
  cookie: {
    maxAge: parseInt(process.env.SESSION_COOKIE_MAX_AGE) || 604800000,
    secure: false, // 🔧 Vercel сам обрабатывает HTTPS
    httpOnly: true,
    sameSite: 'lax', // 🔧 Разрешает кросс-доменные запросы
    path: '/'
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ===== 🎫 PASSPORT DISCORD =====
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

// ===== 🤖 DISCORD BOT CLIENT =====
let bot = null;
try {
  bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  bot.login(process.env.DISCORD_BOT_TOKEN)
    .then(() => console.log('🤖 Synth Bot online'))
    .catch(err => console.error('❌ Bot login error:', err.message));
} catch (e) {
  console.warn('⚠️ Bot client not initialized:', e.message);
}

// ===== ⚡ КЭШ И ПОВТОРНЫЕ ЗАПРОСЫ =====
const guildsCache = new Map();
const CACHE_TTL = 60000; // 60 секунд

async function fetchWithRetry(url, headers, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await axios.get(url, { headers });
    } catch (err) {
      if (err.response?.status === 429 && err.response.data?.retry_after) {
        const wait = err.response.data.retry_after * 1000 + 50;
        console.log(`⏳ Rate limit, waiting ${wait}ms... (${attempt+1}/${maxRetries})`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ===== 🛣️ API ROUTES =====

// 1. Start OAuth — с логированием и обработкой ошибок для Vercel
app.get('/api/auth/discord', (req, res, next) => {
  console.log('🔐 [OAuth Start] Request received', {
    url: req.url,
    headers: { host: req.headers.host, origin: req.headers.origin },
    session: req.session?.id ? '✅' : '❌',
    env: {
      CLIENT_ID_SET: !!process.env.DISCORD_CLIENT_ID,
      REDIRECT_URI: process.env.DISCORD_REDIRECT_URI
    }
  });

  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    console.error('❌ [OAuth] Missing credentials');
    return res.status(500).json({ error: 'Server configuration error: missing Discord credentials' });
  }

  try {
    passport.authenticate('discord', {
      session: true,
      failureRedirect: '/',
      failureMessage: true,
      prompt: 'none'
    })(req, res, (err) => {
      if (err) {
        console.error('❌ [OAuth] Passport error:', err.message);
        return res.status(500).json({ error: 'Authentication failed', details: err.message });
      }
      next();
    });
  } catch (err) {
    console.error('❌ [OAuth] Unexpected error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. OAuth Callback — с детальным логированием
app.get('/api/auth/callback',
  (req, res, next) => {
    console.log('🔐 [OAuth Callback] Request received', {
      query: Object.keys(req.query),
      session: req.session?.id ? '✅' : '❌'
    });
    next();
  },
  passport.authenticate('discord', {
    failureRedirect: '/',
    failureMessage: true,
    failureFlash: true
  }),
  (req, res) => {
    try {
      console.log('✅ [OAuth] Success, user:', req.user?.username, req.user?.id);
      
      const frontendUrl = process.env.FRONTEND_URL || 'https://synth-io.vercel.app';
      const redirectUrl = `${frontendUrl}/dashboard.html`;
      
      console.log('🔄 [OAuth] Redirecting to:', redirectUrl);
      res.redirect(302, redirectUrl);
    } catch (err) {
      console.error('❌ [OAuth] Redirect error:', err.message);
      res.status(500).json({ error: 'Redirect failed' });
    }
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
app.get('/api/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      console.error('❌ Logout error:', err.message);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('synth.sid');
    res.json({ success: true });
  });
});

// 5. Get user's servers WITH BOT INSTALLED
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
    
    // 🔹 Фильтр: только сервера с правами MANAGE_GUILD (0x20)
    const manageable = userGuilds.filter(g => (parseInt(g.permissions) & 0x20) === 0x20);
    
    const serversWithBot = [];
    
    // 🔹 Проверяем наличие бота
    const checks = manageable.map(async (guild) => {
      let botGuild = bot?.guilds?.cache?.get(guild.id);
      
      if (!botGuild && bot?.isReady()) {
        botGuild = await bot.guilds.fetch(guild.id).catch(() => null);
      }
      
      if (botGuild) {
        const icon = guild.icon 
          ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
          : null;
        
        return {
          id: guild.id,
          name: guild.name,
          icon: icon,
          owner: guild.owner,
          permissions: guild.permissions,
          botInstalled: true,
          memberCount: botGuild.memberCount || botGuild.approximateMemberCount || 0,
          onlineCount: botGuild.approximatePresenceCount || 0
        };
      }
      // Если бота нет в кэше — всё равно возвращаем сервер
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null,
        owner: guild.owner,
        permissions: guild.permissions,
        botInstalled: false,
        memberCount: 0,
        onlineCount: 0
      };
    });

    const results = await Promise.all(checks);
    const validServers = results.filter(s => s !== null);
    
    // 🔹 Сохраняем в кэш
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
  
  // Демо-конфиг (в продакшене — загрузка из БД)
  res.json({
    guildId,
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

// 7. Save server config
app.post('/api/servers/:guildId/config', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { guildId } = req.params;
  const updates = req.body;
  
  console.log(`📝 Config updated for ${guildId}:`, updates);
  
  // Демо: лог в консоль (в продакшене — сохранение в БД)
  res.json({ success: true, message: 'Settings saved' });
});

// 8. Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: bot?.isReady() || false,
    servers: bot?.guilds?.cache?.size || 0,
    env: {
      CLIENT_ID_SET: !!process.env.DISCORD_CLIENT_ID,
      REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
      FRONTEND_URL: process.env.FRONTEND_URL,
      VERCEL: !!process.env.VERCEL
    }
  });
});

// ===== 🚀 START SERVER (УНИВЕРСАЛЬНЫЙ) =====

const logEnv = () => {
  console.log('\n🔧 Environment check:');
  console.log(`   • DISCORD_CLIENT_ID: ${process.env.DISCORD_CLIENT_ID ? '✅' : '❌'}`);
  console.log(`   • DISCORD_CLIENT_SECRET: ${process.env.DISCORD_CLIENT_SECRET ? '✅' : '❌'}`);
  console.log(`   • DISCORD_BOT_TOKEN: ${process.env.DISCORD_BOT_TOKEN ? '✅' : '❌'}`);
  console.log(`   • DISCORD_REDIRECT_URI: ${process.env.DISCORD_REDIRECT_URI || '❌'}`);
  console.log(`   • SESSION_SECRET: ${process.env.SESSION_SECRET ? '✅' : '❌'}`);
  console.log(`   • FRONTEND_URL: ${process.env.FRONTEND_URL || '❌'}`);
  console.log(`   • VERCEL: ${process.env.VERCEL ? '✅ (Serverless)' : '❌ (Traditional)'}`);
  console.log(`   • NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   • PORT: ${PORT}`);
};

if (!process.env.VERCEL) {
  // 🔹 Традиционный режим (Railway, Render, локально)
  logEnv();
  
  app.listen(PORT, (err) => {
    if (err) {
      console.error('❌ Failed to start server:', err.message);
      process.exit(1);
    }
    
    const frontendUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
    console.log(`\n🚀 Backend running on port ${PORT}`);
    console.log(`🌐 Frontend URL: ${frontendUrl}`);
    console.log(`🔗 Health check: ${frontendUrl}/api/health\n`);
  });
} else {
  // 🔹 Режим Vercel Serverless — app.listen() не вызывается
  logEnv();
  console.log(`\n☁️ Running on Vercel Serverless — using serverless-http handler\n`);
}

// 📦 Экспорт для serverless-http (Vercel) и тестов
module.exports = app;
