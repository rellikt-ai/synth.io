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

// ===== MIDDLEWARE =====
app.use(cors({ 
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true 
}));
app.use(express.json());
app.use(express.static('../frontend'));

// ===== SESSION =====
app.use(session({
  secret: process.env.SESSION_SECRET,
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
  .catch(err => console.error('❌ Bot login error:', err));

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
    res.redirect(`${process.env.FRONTEND_URL}/dashboard.html`);
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
  
  // 🔹 Проверяем кэш (чтобы не долбить API при каждом обновлении)
  const cached = guildsCache.get(userId);
  if (cached && (now - cached.timestamp < CACHE_TTL)) {
    return res.json(cached.servers);
  }
  
  try {
    // 🔹 1. Получаем список серверов пользователя (быстро)
    const response = await fetchWithRetry(
      'https://discord.com/api/users/@me/guilds',
      { Authorization: `Bearer ${req.user.accessToken}` }
    );
    const userGuilds = response.data;
    
    // 🔹 2. Фильтр прав
    const manageable = userGuilds.filter(g => (parseInt(g.permissions) & 0x20) === 0x20);
    
    const serversWithBot = [];
    
    // 🔹 3. Проверяем наличие бота (ИСПОЛЬЗУЕМ Promise.all для скорости)
    const checks = manageable.map(async (guild) => {
      let botGuild = bot.guilds.cache.get(guild.id);
      
      // 🔸 Если нет в кэше — запрашиваем (одиночно)
      if (!botGuild) {
        botGuild = await bot.guilds.fetch(guild.id).catch(() => null);
      }
      
      if (botGuild) {
        const icon = guild.icon 
          ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
          : null;
        
        // 🔸 БЕРЕМ ДАННЫЕ ИЗ КЭША (МГНОВЕННО), НЕ ДЕЛАЕМ FETCH УЧАСТНИКОВ
        const memberCount = botGuild.memberCount || botGuild.approximateMemberCount || 0;
        const onlineCount = botGuild.approximatePresenceCount || 0;

        return {
          id: guild.id,
          name: guild.name,
          icon: icon,
          owner: guild.owner,
          permissions: guild.permissions,
          botInstalled: true,
          memberCount: memberCount, // Теперь это занимает 0 мс
          onlineCount: onlineCount
        };
      }
      return null;
    });

    // 🔹 4. Ждем выполнения всех проверок параллельно
    const results = await Promise.all(checks);
    
    // 🔹 5. Убираем null (серверы без бота)
    const validServers = results.filter(s => s !== null);
    
    // 🔹 6. Сохраняем в кэш
    guildsCache.set(userId, { servers: validServers, timestamp: now });
    
    console.log(`✅ Returned ${validServers.length} servers instantly for ${userId}`);
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
  
  // Демо-конфиг (в продакшене — загрузка из БД)
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
  
  // Демо: лог в консоль (в продакшене — сохранение в БД)
  console.log(`📝 Config updated for ${guildId}:`, updates);
  
  res.json({ success: true, message: 'Settings saved' });
});

// 8. Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: bot.isReady(),
    servers: bot.guilds.cache.size
  });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
});