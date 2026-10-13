require('dotenv').config();

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
}

const botUsername = normalizeUsername(
  process.env.BOT_USERNAME || process.env.BOT_LINK || process.env.BOT_ID
);
const adminUsername = normalizeUsername(process.env.ADMIN_USERNAME);
const adminTelegramId = Number(process.env.ADMIN_TG_ID);
const mongoUri = process.env.MONGODB_URI;
if (mongoUri) {
  const parsedMongoUri = new URL(mongoUri);
  if (!parsedMongoUri.searchParams.has('authSource')) {
    parsedMongoUri.searchParams.set('authSource', 'admin');
  }
  process.env.MONGODB_URI = parsedMongoUri.toString();
}

function getMissingSettings() {
  const missingSettings = [];
  if (!process.env.BOT_TOKEN) missingSettings.push('BOT_TOKEN');
  if (!process.env.MONGODB_URI) missingSettings.push('MONGODB_URI');
  if (!botUsername) missingSettings.push('BOT_USERNAME');
  if (!adminUsername) missingSettings.push('ADMIN_USERNAME');
  if (!Number.isSafeInteger(adminTelegramId) || adminTelegramId <= 0) missingSettings.push('ADMIN_TG_ID');
  return missingSettings;
}

function validateConfig() {
  const missingSettings = getMissingSettings();
  if (missingSettings.length > 0) {
    throw new Error(`Missing configuration: ${missingSettings.join(', ')}. Update .env before starting the bot.`);
  }
}

module.exports = {
  botToken: process.env.BOT_TOKEN,
  mongoUri: process.env.MONGODB_URI,
  botUsername,
  botLink: botUsername ? `https://t.me/${botUsername}` : '',
  admin: {
    username: adminUsername,
    publicUsername: adminUsername ? `@${adminUsername}` : '',
    telegramId: adminTelegramId
  },
  timezone: process.env.BOT_TIMEZONE || 'Asia/Tashkent',
  validateConfig
};
