// api/index.js
const serverless = require('serverless-http');
const app = require('../server'); // Импортируем основной Express-приложение

// Экспортируем handler для Vercel Serverless
module.exports.handler = serverless(app);
