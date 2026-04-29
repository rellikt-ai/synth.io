// api/index.js — точка входа для Vercel Serverless
const serverless = require('serverless-http');
const app = require('../server'); // Импортируем Express-приложение

// ✅ ПРАВИЛЬНЫЙ ЭКСПОРТ ДЛЯ VERCEL: дефолтная функция-обработчик
module.exports = serverless(app);
