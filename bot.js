require('dotenv').config();
const config = require('./config');
process.env.TZ = config.timezone;

const mongoose = require('mongoose');
const express = require('express');
const crypto = require('crypto');
const { Telegraf, Markup, session } = require('telegraf');
const { createTelegramAccountManager } = require('./telegram-account-manager');

const mongoConnection = mongoose.connection;

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true, index: true },
  username: { type: String, default: '' },
  nickname: { type: String, default: '' },
  joinedAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now }
}, { versionKey: false });

const adminSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true, index: true },
  username: { type: String, default: '' },
  nickname: { type: String, default: '' },
  permissions: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const sessionSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 }
}, { versionKey: false });

const broadcastSchema = new mongoose.Schema({
  total: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  blocked: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const adminLogSchema = new mongoose.Schema({
  adminTelegramId: { type: Number, required: true, index: true },
  adminName: { type: String, default: '' },
  action: { type: String, required: true },
  details: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

const joinRequestChatSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true, required: true, index: true },
  title: { type: String, default: '' },
  type: { type: String, enum: ['channel', 'group', 'supergroup'], required: true },
  username: { type: String, default: '' },
  linkedBy: { type: Number, default: null },
  paused: { type: Boolean, default: false },
  welcomeMessage: { type: String, default: 'Sizni tez orada qabul qilamiz!' },
  welcomeEntities: { type: [mongoose.Schema.Types.Mixed], default: [] },
  welcomeMediaType: { type: String, enum: ['', 'photo', 'video', 'animation'], default: '' },
  welcomeMediaFileId: { type: String, default: '' },
  welcomeButtons: { type: [mongoose.Schema.Types.Mixed], default: [] },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const pendingJoinRequestSchema = new mongoose.Schema({
  chatId: { type: Number, required: true },
  userId: { type: Number, required: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  requestedAt: { type: Date, required: true },
  receivedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
}, { versionKey: false });
pendingJoinRequestSchema.index({ chatId: 1, userId: 1 }, { unique: true });

const joinRequestLinkCodeSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true, index: true },
  codeHash: { type: String, unique: true, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
  claimedAt: { type: Date, default: null },
  claimedChatId: { type: Number, default: null }
}, { versionKey: false });

const telegramAccountSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true, index: true },
  encryptedSession: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

const botConfigSchema = new mongoose.Schema({
  configKey: { type: String, default: 'main_config', unique: true },
  channels: { type: Array, default: [] },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { versionKey: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Admin = mongoose.models.BotAdmin || mongoose.model('BotAdmin', adminSchema);
const BotConfig = mongoose.models.BotConfig || mongoose.model('BotConfig', botConfigSchema);
const Session = mongoose.models.BotSession || mongoose.model('BotSession', sessionSchema);
const Broadcast = mongoose.models.Broadcast || mongoose.model('Broadcast', broadcastSchema);
const AdminLog = mongoose.models.AdminLog || mongoose.model('AdminLog', adminLogSchema);
const JoinRequestChat = mongoose.models.JoinRequestChat || mongoose.model('JoinRequestChat', joinRequestChatSchema);
const PendingJoinRequest = mongoose.models.PendingJoinRequest || mongoose.model('PendingJoinRequest', pendingJoinRequestSchema);
const JoinRequestLinkCode = mongoose.models.JoinRequestLinkCode || mongoose.model('JoinRequestLinkCode', joinRequestLinkCodeSchema);
const TelegramAccount = mongoose.models.TelegramAccount || mongoose.model('TelegramAccount', telegramAccountSchema);

const telegramAccountManager = createTelegramAccountManager({
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  encryptionKey: process.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
  loadSession: async (telegramId) => TelegramAccount.findOne({ telegramId }).lean(),
  saveSession: async (telegramId, encryptedSession) => TelegramAccount.findOneAndUpdate(
    { telegramId },
    { $set: { encryptedSession, updatedAt: new Date() } },
    { upsert: true }
  ),
  deleteSession: async (telegramId) => TelegramAccount.deleteOne({ telegramId }),
  sendMessage: async (telegramId, text) => bot.telegram.sendMessage(telegramId, text, { protect_content: true })
});

const app = express();
const port = Number(process.env.PORT) || 3000;
app.get('/', (req, res) => res.send('Movie bot ishlamoqda...'));
app.get('/health', (req, res) => res.status(200).json({
  ok: true,
  mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
}));

const bot = new Telegraf(config.botToken);
const ADMIN_USERNAME = config.admin.username;
const ADMIN_TG_ID = config.admin.telegramId;
const adminPermissions = ['broadcast', 'stats', 'settings', 'join_requests', 'admins'];
const adminRegistry = new Map();
const joinRequestChatIds = new Set();
const pendingJoinApprovals = new Set();
const pendingBulkJoinApprovals = new Set();
const data = { settings: { requiredChannels: [] } };
const premiumEmojis = {
  welcome: '<tg-emoji emoji-id="5199785165735367039">⚡️</tg-emoji>',
  bot: '<tg-emoji emoji-id="5323359973365784232">🤖</tg-emoji>',
  confirm: '<tg-emoji emoji-id="5393275607083676065">✔️</tg-emoji>',
  warning: '<tg-emoji emoji-id="5215351548850218245">⚠️</tg-emoji>',
  web: '<tg-emoji emoji-id="5231482153228835967">🌐</tg-emoji>'
};
const defaultMessages = {
  welcome: `${premiumEmojis.welcome} Assalomu alaykum {nickname}\n\n${premiumEmojis.bot} Botni kanal yoki guruhga administrator qiling va /connect bilan ulang. Eski so\'rovlarni ko\'rish uchun /telegram_login orqali Telegram akkauntingizni ulang. Boshqarish uchun /mychats buyrug\'ini yuboring.`,
  subscriptionRequired: `${premiumEmojis.warning} Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling`,
  help: `${premiumEmojis.web} Guruh uchun botni administrator qiling va guruhda /connect yuboring. Kanal uchun avval botning shaxsiy chatida /connect yuboring, berilgan 6 xonali kodni kanalda /connect 123456 ko\'rinishida yuboring. Kanalga bot admin bo\'lishidan oldingi so\'rovlarni ham ko\'rish uchun /telegram_login orqali o\'z Telegram akkauntingizni ulang. Chatlaringizni /mychats bilan boshqaring; avtomatik qabulni to\'xtatib, kutilayotgan so\'rovlarni tugma bilan tasdiqlashingiz mumkin.`
};
function isAdmin(ctx) {
  const telegramId = Number(ctx.from?.id);
  if (telegramId === ADMIN_TG_ID || ctx.from?.username?.toLowerCase() === ADMIN_USERNAME) return true;
  const record = adminRegistry.get(telegramId);
  return Boolean(record?.active);
}

function isOwner(ctx) {
  return Number(ctx.from?.id) === ADMIN_TG_ID || ctx.from?.username?.toLowerCase() === ADMIN_USERNAME;
}

function hasPermission(ctx, permission) {
  if (isOwner(ctx)) return true;
  const record = adminRegistry.get(Number(ctx.from?.id));
  return Boolean(record?.active && record.permissions.includes(permission));
}

function permissionsLabel(permissions) {
  const labels = {
    broadcast: 'Xabar yuborish',
    stats: 'Statistika',
    settings: 'Obuna sozlamalari',
    join_requests: 'Qo\'shilish so\'rovlari',
    admins: 'Adminlar'
  };
  return permissions.filter((permission) => adminPermissions.includes(permission))
    .map((permission) => labels[permission]).join(', ') || 'Huquq berilmagan';
}

function adminManagementKeyboard(admin) {
  const rows = adminPermissions.map((permission) => [Markup.button.callback(
    `${admin.permissions.includes(permission) ? '✅' : '⬜'} ${permission}`,
    `admin:perm:${admin.telegramId}:${permission}`
  )]);
  rows.push([Markup.button.callback('🗑 Adminni o\'chirish', `admin:remove:${admin.telegramId}`)]);
  rows.push([Markup.button.callback('⬅️ Adminlar ro\'yxati', 'admin:admins')]);
  return Markup.inlineKeyboard(rows);
}

async function refreshAdminRegistry() {
  adminRegistry.clear();
  const admins = await Admin.find({ active: true }).lean();
  admins.forEach((admin) => adminRegistry.set(admin.telegramId, admin));
}

async function logAdminAction(ctx, action, details = '') {
  if (!ctx.from?.id) return;
  try {
    await AdminLog.create({
      adminTelegramId: Number(ctx.from.id),
      adminName: ctx.from.first_name || ctx.from.username || '',
      action,
      details
    });
  } catch (error) {
    console.error('Admin log failed:', error.message);
  }
}

function reset(ctx) {
  ctx.session = {};
}

function activateAdminPanel(ctx) {
  ctx.session = { adminPanelActive: true };
}

function isAdminPanelActive(ctx) {
  return isAdmin(ctx) && ctx.session?.adminPanelActive === true;
}

function shouldProtectContent(chatId) {
  return Number(chatId) !== ADMIN_TG_ID;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeChannel(value) {
  const trimmed = String(value || '').trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function adminKeyboard(ctx) {
  const can = (permission) => !ctx || hasPermission(ctx, permission);
  const rows = [];
  if (can('stats')) rows.push([
    Markup.button.callback('📊 Statistika', 'admin:stats')
  ]);
  if (can('broadcast')) rows.push([
    Markup.button.callback('📣 Xabar yuborish', 'admin:broadcast')
  ]);
  if (can('settings')) {
    rows.push([Markup.button.callback('➕ Obuna kanalini qo\'shish', 'admin:subscription')]);
    rows.push([
      Markup.button.callback('📋 Obuna kanallari', 'admin:required_list'),
      Markup.button.callback('❌ Obunani o\'chirish', 'admin:subscription_off')
    ]);
  }
  if (isOwner(ctx || {})) rows.push([Markup.button.callback('👥 Adminlarni boshqarish', 'admin:admins')]);
  if (isOwner(ctx || {})) rows.push([Markup.button.callback('🧾 Admin loglari', 'admin:logs')]);
  rows.push([Markup.button.callback('🚪 Paneldan chiqish', 'admin:exit')]);
  return Markup.inlineKeyboard(rows);
}

function userKeyboard(ctx) {
  return isAdmin(ctx) ? Markup.keyboard([['Admin panel']]).resize() : Markup.removeKeyboard();
}

const persistentSessionStore = {
  async get(key) {
    const record = await Session.findOne({ key }).lean();
    return record?.data;
  },
  async set(key, value) {
    await Session.findOneAndUpdate(
      { key },
      { $set: { data: value, updatedAt: new Date() } },
      { upsert: true }
    );
  },
  async delete(key) {
    await Session.deleteOne({ key });
  }
};

function formatMessage(template, ctx) {
  const nickname = ctx.from?.first_name || ctx.from?.username || 'foydalanuvchi';
  return String(template).replace(/\{(nickname|bot_username)\}/g, (match, key) => ({
    nickname,
    bot_username: config.botUsername
  }[key] ?? match));
}

function configuredMessage(key, ctx) {
  return formatMessage(data.settings.messages?.[key] || defaultMessages[key], ctx);
}

function replyOptions(replyMarkup) {
  return replyMarkup ? { parse_mode: 'HTML', reply_markup: replyMarkup } : { parse_mode: 'HTML' };
}

function welcomeMessage(ctx) {
  return configuredMessage('welcome', ctx);
}

function welcomeMarkup(ctx) {
  const rows = [
    [{ text: '➕ Kanal/guruh ulash', callback_data: 'welcome:join_chat_connect', style: 'primary' }],
    [{ text: '📋 Ulangan kanallar ro\'yxati', callback_data: 'welcome:required_list', style: 'success' }],
    [{ text: '🔐 Telegram akkauntini ulash', callback_data: 'account:login', style: 'primary' }]
  ];
  const bottomRow = [{ text: '❓ Yordam', callback_data: 'help', style: 'success' }];
  if (isAdmin(ctx)) bottomRow.push({ text: '🛠 Admin panel', callback_data: 'admin:panel', style: 'success' });
  rows.push(bottomRow);
  return Markup.inlineKeyboard(rows).reply_markup;
}

function subscriptionKeyboard(channels) {
  const rows = channels.map((channel, index) => [Markup.button.url(
    `📢 ${index + 1} - kanal`,
    `https://t.me/${String(channel.username).replace(/^@/, '')}`
  )]);
  rows.push([Markup.button.callback('✅ Tekshirish', 'check_subscription')]);
  return Markup.inlineKeyboard(rows);
}

async function getRequiredChannels() {
  const configDocument = await BotConfig.findOne({ configKey: 'main_config' }, { channels: 1 }).lean();
  return configDocument?.channels || data.settings.requiredChannels || [];
}

async function requiredSubscription(ctx) {
  if (isAdmin(ctx)) return true;
  const channels = await getRequiredChannels();
  if (!channels.length) return true;

  const notSubscribed = [];
  for (const channel of channels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.id, ctx.from.id);
      if (!['creator', 'administrator', 'member'].includes(member.status)) notSubscribed.push(channel);
    } catch (error) {
      console.error('Subscription check failed:', error.response?.description || error.message);
      notSubscribed.push(channel);
    }
  }

  if (!notSubscribed.length) return true;
  await ctx.reply(configuredMessage('subscriptionRequired', ctx), replyOptions(subscriptionKeyboard(notSubscribed).reply_markup));
  return false;
}

async function checkFullAdmin(ctx, username) {
  const chat = await ctx.telegram.getChat(username);
  if (chat.type !== 'channel') throw new Error('Bu username kanalga tegishli emas.');

  const userMember = await ctx.telegram.getChatMember(chat.id, ctx.from.id);
  if (!['creator', 'administrator'].includes(userMember.status)) {
    throw new Error('Kanalni qo\'shish uchun kanalda admin yoki ega bo\'lishingiz kerak.');
  }
  const botInfo = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chat.id, botInfo.id);
  if (!['creator', 'administrator'].includes(member.status)) {
    throw new Error('Bot kanalida administrator bo\'lishi kerak.');
  }
  if (member.status === 'administrator' && member.can_post_messages === false) {
    throw new Error('Botga kanalda post yuborish huquqini bering.');
  }
  return { id: chat.id, title: chat.title || username, username: chat.username ? `@${chat.username}` : username };
}

async function saveSettings() {
  await BotConfig.findOneAndUpdate(
    { configKey: 'main_config' },
    { $set: { channels: data.settings.requiredChannels, settings: { messages: data.settings.messages } } },
    { upsert: true }
  );
}

async function hydrateSettings() {
  await mongoConnection;
  const admins = await Admin.find({ active: true }).lean();
  adminRegistry.clear();
  admins.forEach((admin) => adminRegistry.set(admin.telegramId, admin));
  const linkedChats = await JoinRequestChat.find({}, { chatId: 1 }).lean();
  joinRequestChatIds.clear();
  linkedChats.forEach((chat) => joinRequestChatIds.add(String(chat.chatId)));
  let configDocument = await BotConfig.findOne({ configKey: 'main_config' }).lean();
  if (!configDocument) {
    configDocument = await BotConfig.create({ configKey: 'main_config', channels: [], settings: {} });
    configDocument = configDocument.toObject();
  }
  data.settings.requiredChannels = configDocument.channels || [];
  data.settings.messages = { ...defaultMessages };
}

async function ensureUser(ctx) {
  const telegramId = Number(ctx.from.id);
  const existingUser = await User.findOne({ telegramId }).lean();
  const userData = {
    username: ctx.from.username || '',
    nickname: ctx.from.first_name || ctx.from.last_name || '',
    lastActiveAt: new Date()
  };
  if (existingUser) {
    await User.updateOne({ telegramId }, { $set: userData });
    return { user: { ...existingUser, ...userData }, isNew: false };
  }
  try {
    const user = await User.create({ telegramId, ...userData });
    return { user: user.toObject(), isNew: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    await User.updateOne({ telegramId }, { $set: userData });
    return { user: await User.findOne({ telegramId }).lean(), isNew: false };
  }
}

async function notifyNewSubscriber(ctx) {
  if (isAdmin(ctx)) return;
  const count = await User.countDocuments();
  const nickname = escapeHtml(ctx.from.first_name || ctx.from.last_name || ctx.from.username || 'foydalanuvchi');
  const profileLink = `<a href="tg://user?id=${Number(ctx.from.id)}">${nickname}</a>`;
  await bot.telegram.sendMessage(
    ADMIN_TG_ID,
    `Botga yangi obunachi qo'shildi: ${profileLink}\nObunachilar soni: ${count}`,
    { parse_mode: 'HTML', protect_content: false }
  );
}

function broadcastKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➡️ Rasmsiz davom etish', 'broadcast:no_media')],
    [Markup.button.callback('❌ Bekor qilish', 'broadcast:cancel')]
  ]);
}

function broadcastButtonKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Yana tugma qo\'shish', 'broadcast:add_button')],
    [Markup.button.callback('👁 Preview', 'broadcast:preview')],
    [Markup.button.callback('❌ Bekor qilish', 'broadcast:cancel')]
  ]);
}

function broadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Yuborish', 'broadcast:send')],
    [Markup.button.callback('❌ Bekor qilish', 'broadcast:cancel')]
  ]);
}

function broadcastColorKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔵 Ko\'k', 'broadcast:color:blue'), Markup.button.callback('🟢 Yashil', 'broadcast:color:green')],
    [Markup.button.callback('🔴 Qizil', 'broadcast:color:red')]
  ]);
}

function broadcastExtra(broadcast, chatId) {
  const replyMarkup = broadcast.buttons?.length
    ? Markup.inlineKeyboard(broadcast.buttons).reply_markup
    : undefined;
  const commonExtra = replyMarkup ? { reply_markup: replyMarkup } : {};
  commonExtra.protect_content = shouldProtectContent(chatId);
  const textExtra = {
    ...commonExtra,
    ...(broadcast.captionEntities?.length
      ? { entities: broadcast.captionEntities }
      : { parse_mode: 'HTML' })
  };
  const mediaExtra = {
    ...commonExtra,
    ...(broadcast.captionEntities?.length
      ? { caption_entities: broadcast.captionEntities }
      : { parse_mode: 'HTML' })
  };
  return { textExtra, mediaExtra };
}

async function sendBroadcastMessage(chatId, broadcast) {
  const { textExtra, mediaExtra } = broadcastExtra(broadcast, chatId);
  if (broadcast.mediaType === 'photo') {
    return bot.telegram.sendPhoto(chatId, broadcast.media, { ...mediaExtra, caption: broadcast.caption || undefined });
  }
  if (broadcast.mediaType === 'video') {
    return bot.telegram.sendVideo(chatId, broadcast.media, { ...mediaExtra, caption: broadcast.caption || undefined });
  }
  if (broadcast.mediaType === 'animation') {
    return bot.telegram.sendAnimation(chatId, broadcast.media, { ...mediaExtra, caption: broadcast.caption || undefined });
  }
  return bot.telegram.sendMessage(chatId, broadcast.caption || ' ', textExtra);
}

async function previewBroadcast(ctx) {
  const broadcast = ctx.session?.broadcast;
  if (!broadcast) return ctx.reply('Xabar yuborish jarayoni topilmadi.');
  try {
    await sendBroadcastMessage(ctx.from.id, broadcast);
    broadcast.previewed = true;
    return ctx.reply('Preview yuborildi. Tekshirib, yuborishni tasdiqlang.', broadcastConfirmKeyboard());
  } catch (error) {
    return ctx.reply(`Preview yuborilmadi: ${error.response?.description || error.message}`);
  }
}

async function sendBroadcast(ctx) {
  const broadcast = ctx.session?.broadcast;
  if (!broadcast) return ctx.reply('Xabar yuborish jarayoni topilmadi.');
  const users = await User.find({}, { telegramId: 1 }).lean();
  const log = await Broadcast.create({ total: users.length });
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let processed = 0;
  for (const user of users) {
    try {
      const chat = await bot.telegram.getChat(user.telegramId);
      if (chat.type !== 'private') continue;
      await sendBroadcastMessage(user.telegramId, broadcast);
      sent += 1;
    } catch (error) {
      failed += 1;
      if (error.response?.error_code === 403) blocked += 1;
      console.error(`Broadcast to ${user.telegramId} failed:`, error.response?.description || error.message);
    }
    processed += 1;
    if (processed % 25 === 0 || processed === users.length) {
      await ctx.telegram.sendMessage(ctx.from.id, `Broadcast progress: ${processed} / ${users.length} yuborildi`, { protect_content: false });
    }
  }
  await Broadcast.updateOne({ _id: log._id }, { $set: { sent, failed, blocked } });
  return { total: users.length, sent, failed, blocked };
}

async function adminStats(ctx) {
  const now = Date.now();
  const [subscribers, activeUsers, broadcasts, linkedChats] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ lastActiveAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
    Broadcast.aggregate([{ $group: { _id: null, total: { $sum: 1 }, sent: { $sum: '$sent' }, failed: { $sum: '$failed' }, blocked: { $sum: '$blocked' } } }]),
    JoinRequestChat.countDocuments()
  ]);
  const broadcastStats = broadcasts[0] || { total: 0, sent: 0, failed: 0, blocked: 0 };
  return ctx.reply(`<tg-emoji emoji-id="5244825199278311613">📊</tg-emoji> Bot statistikasi\n\n` +
    `<blockquote>Obunachilar: ${subscribers}\nFaol userlar (24 soat): ${activeUsers}\nJami ulangan chatlar: ${linkedChats}</blockquote>\n\n` +
    `<blockquote>Broadcastlar: ${broadcastStats.total}\nYetib borgan: ${broadcastStats.sent}\nBloklagan: ${broadcastStats.blocked}\nXatolik: ${broadcastStats.failed}</blockquote>`,
    replyOptions(adminKeyboard(ctx).reply_markup));
}

async function handleStart(ctx) {
  const registration = await ensureUser(ctx);
  if (registration.isNew) {
    try {
      await notifyNewSubscriber(ctx);
    } catch (error) {
      console.error('New subscriber notification failed:', error.response?.description || error.message);
    }
  }
  if (!(await requiredSubscription(ctx))) return;
  return ctx.reply(welcomeMessage(ctx), replyOptions(welcomeMarkup(ctx) || userKeyboard(ctx).reply_markup));
}

bot.use(async (ctx, next) => {
  if (ctx.chatJoinRequest || ctx.myChatMember) return next();
  if (ctx.chat && ctx.chat.type !== 'private' && !isChatLinkCommand(getChatCommand(ctx))) return;
  return next();
});

bot.use(session({ store: persistentSessionStore }));

bot.use(async (ctx, next) => {
  const reply = ctx.reply.bind(ctx);
  ctx.reply = (text, extra = {}) => reply(text, { ...(extra || {}), protect_content: !isAdmin(ctx) });
  return next();
});

bot.start(handleStart);

bot.use(async (ctx, next) => {
  const isChatCommand = ctx.chat && ctx.chat.type !== 'private' && isChatLinkCommand(getChatCommand(ctx));
  if (ctx.chatJoinRequest || ctx.myChatMember || isChatCommand) return next();
  if (/^\/(?:connect|disconnect|mychats)(?:@\w+)?(?:\s|$)/i.test(ctx.message?.text || '') ||
      /^(?:join_chat:|join_request:)/.test(ctx.callbackQuery?.data || '')) return next();
  if (ctx.from && ctx.message?.text !== '/start') await ensureUser(ctx);
  if (ctx.callbackQuery?.data === 'check_subscription') return next();
  if (ctx.callbackQuery?.data && isAdmin(ctx) &&
      /^(?:admin:|broadcast:)/.test(ctx.callbackQuery.data) &&
      ctx.callbackQuery.data !== 'admin:panel' && !isAdminPanelActive(ctx)) {
    await ctx.answerCbQuery('Avval /admin orqali panelni oching.', { show_alert: true });
    return;
  }
  if (ctx.callbackQuery?.data && isAdmin(ctx)) {
    const permission = permissionForCallback(ctx.callbackQuery.data);
    if (permission && !hasPermission(ctx, permission)) {
      await ctx.answerCbQuery('Bu amal uchun sizda huquq yo\'q.', { show_alert: true });
      return;
    }
  }
  if (isAdmin(ctx) || telegramAccountManager.isLoginActive(ctx.from?.id)) return next();
  if (await requiredSubscription(ctx)) return next();
});

bot.command('connect', async (ctx) => {
  const chat = ctx.chat;
  const argument = getChatCommand(ctx).replace(/^\/connect(?:@\w+)?\s*/i, '').trim();
  if (chat?.type === 'private') {
    if (argument) return ctx.reply('Kod olish uchun argumentlarsiz /connect yuboring.');
    return issueJoinRequestLinkCode(ctx);
  }
  if (!chat || !['group', 'supergroup'].includes(chat.type)) {
    return;
  }
  if (/^\d{6}$/.test(argument)) return handleJoinRequestConnectCode(ctx, getChatCommand(ctx));
  return replyPrivatelyAndDelete(ctx, chat, ctx.message.message_id, ctx.from?.id,
    'Botning shaxsiy chatida /connect yuborib 6 xonali kod oling, keyin guruhda /connect 123456 yuboring.');
});

bot.command('disconnect', async (ctx) => {
  const chat = ctx.chat;
  const argument = getChatCommand(ctx).replace(/^\/disconnect(?:@\w+)?\s*/i, '').trim();
  if (chat?.type === 'private' && argument) {
    const chatId = Number(argument);
    if (!Number.isSafeInteger(chatId)) {
      return ctx.reply('Shaxsiy chatda uzish uchun chat ID yuboring. /mychats orqali ham uzishingiz mumkin.');
    }
    const linkedChat = await JoinRequestChat.findOne({ chatId }).lean();
    if (!linkedChat) return ctx.reply('Ulangan chat topilmadi.');
    return handleJoinChatCommand(ctx, getChatCommand(ctx), {
      id: linkedChat.chatId,
      title: linkedChat.title,
      type: linkedChat.type,
      username: linkedChat.username?.replace(/^@/, '')
    }, ctx.from?.id);
  }
  if (!chat || !['group', 'supergroup'].includes(chat.type)) {
    return ctx.reply('Guruhda /disconnect yuboring yoki /mychats orqali chatni tanlang.');
  }
  return handleJoinChatCommand(ctx, getChatCommand(ctx), chat, ctx.from?.id);
});

bot.command('mychats', showJoinRequestChats);

bot.command('telegram_login', async (ctx) => {
  if (ctx.chat?.type !== 'private') return ctx.reply('Telegram akkauntini botning shaxsiy chatida ulang.');
  try {
    await telegramAccountManager.beginLogin(ctx.from.id);
  } catch (error) {
    return ctx.reply(error.message);
  }
});

bot.command('telegram_logout', async (ctx) => {
  if (ctx.chat?.type !== 'private') return ctx.reply('Bu buyruqni botning shaxsiy chatida yuboring.');
  await telegramAccountManager.logout(ctx.from.id);
  return ctx.reply('Telegram akkauntingiz botdan uzildi va saqlangan sessiya o\'chirildi.');
});

bot.action('account:login', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.chat?.type !== 'private') return ctx.reply('Telegram akkauntini botning shaxsiy chatida ulang.');
  try {
    await telegramAccountManager.beginLogin(ctx.from.id);
  } catch (error) {
    return ctx.reply(error.message);
  }
});

bot.on('channel_post', handleChannelLinkCommand);

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  const chatId = update?.chat.id;
  if (!chatId || !joinRequestChatIds.has(String(chatId))) return;

  const member = update.new_chat_member;
  const linkedChat = await JoinRequestChat.findOne({ chatId }).lean();
  if (!linkedChat) {
    joinRequestChatIds.delete(String(chatId));
    return;
  }
  const hasRequiredRights = member.status === 'creator' ||
    (member.status === 'administrator' &&
      member.can_invite_users === true &&
      member.can_delete_messages === true);
  if (hasRequiredRights) return;

  await JoinRequestChat.deleteOne({ chatId });
  joinRequestChatIds.delete(String(chatId));
  console.warn(`Join-request processing disabled for chat ${chatId}: bot lost administrator invite or delete permission.`);
});

bot.action('admin:join_chats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || !hasPermission(ctx, 'join_requests')) return ctx.reply('Ruxsat yo\'q.');
  return ctx.reply('Ulangan chatlar soni Statistika bo\'limida ko\'rsatiladi.', adminKeyboard(ctx));
});

bot.action('join_chat:list', async (ctx) => {
  await ctx.answerCbQuery();
  return showJoinRequestChats(ctx);
});

bot.action(/^join_chat:open:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply(chat === null ? 'Ulangan chat topilmadi.' : 'Bu chatni boshqarish uchun uning administratori bo\'lishingiz kerak.');
  let syncWarning = '';
  try {
    await syncJoinRequestArchive(ctx.from.id, chat);
  } catch (error) {
    syncWarning = '\n⚠️ Eski so\'rovlarni yangilab bo\'lmadi.';
    console.error(`Could not sync pending join requests for ${chatId}:`, error.message);
  }
  const pendingCount = await PendingJoinRequest.countDocuments({ chatId });
  return ctx.reply(
    `${chat.title || chat.username || chat.chatId}\nHolat: ${chat.paused ? '⏸ To\'xtatilgan' : '▶️ Avtomatik qabul yoqilgan'}${syncWarning}`,
    chatManagementKeyboard(chat, pendingCount)
  );
});

bot.action(/^join_chat:(pause|resume):(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[2]);
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply(chat === null ? 'Ulangan chat topilmadi.' : 'Bu chatni boshqarish uchun uning administratori bo\'lishingiz kerak.');
  const paused = ctx.match[1] === 'pause';
  const updatedChat = await JoinRequestChat.findOneAndUpdate(
    { chatId },
    { $set: { paused } },
    { returnDocument: 'after' }
  ).lean();
  return ctx.reply(
    paused
      ? '⏸ Avtomatik qabul to\'xtatildi. Yangi so\'rovlar kutilayotganlar ro\'yxatiga tushadi.'
      : '▶️ Avtomatik qabul davom ettirildi. To\'xtatilgan vaqtda yig\'ilgan so\'rovlar ro\'yxatda qoladi; ularni alohida tasdiqlashingiz mumkin.',
    chatManagementKeyboard(updatedChat, await PendingJoinRequest.countDocuments({ chatId }))
  );
});

bot.action(/^join_chat:edit_welcome:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply('Chat topilmadi yoki bu chatni boshqarish huquqingiz yo\'q.');
  ctx.session = {
    step: 'join_welcome_media',
    joinRequestChatId: chatId,
    joinWelcomeDraft: {
      message: chat.welcomeMessage || 'Sizni tez orada qabul qilamiz!',
      entities: chat.welcomeEntities || [],
      mediaType: chat.welcomeMediaType || '',
      mediaFileId: chat.welcomeMediaFileId || '',
      buttons: chat.welcomeButtons || []
    }
  };
  return ctx.reply(
    'Ariza yuborganlarga boradigan salomlashuvni sozlang. Media yuboring yoki quyidagi tugmalardan birini tanlang. ' +
    'Kanal/guruh nomi boshiga avtomatik qo\'shiladi; premium emoji matnda saqlanadi.',
    joinWelcomeMediaKeyboard(ctx.session.joinWelcomeDraft)
  );
});

bot.action(/^join_welcome:(keep_media|no_media)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.joinWelcomeDraft || ctx.session.step !== 'join_welcome_media') {
    return ctx.reply('Salomlashuv tahrirlash jarayoni topilmadi.');
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
  }
  if (ctx.match[1] === 'no_media') {
    ctx.session.joinWelcomeDraft.mediaType = '';
    ctx.session.joinWelcomeDraft.mediaFileId = '';
  }
  ctx.session.step = 'join_welcome_text';
  return ctx.reply(
    'Salomlashuv matnini yuboring (1–4096 belgi). Premium emoji ishlatishingiz mumkin. ' +
    'Matn xabari Telegram yuborgan format va emoji ma\'lumotlari bilan saqlanadi.'
  );
});

bot.action('join_welcome:add_button', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.joinWelcomeDraft || ctx.session.step !== 'join_welcome_controls') {
    return ctx.reply('Avval salomlashuv matnini kiriting.');
  }
  if (ctx.session.joinWelcomeDraft.buttons.length >= 8) {
    return ctx.reply('Ko\'pi bilan 8 ta havolali tugma qo\'shish mumkin.');
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
  }
  ctx.session.step = 'join_welcome_button_text';
  return ctx.reply('Havolali tugma matnini yuboring (1–64 belgi):');
});

bot.action('join_welcome:clear_buttons', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.joinWelcomeDraft || ctx.session.step !== 'join_welcome_controls') {
    return ctx.reply('Salomlashuv tahrirlash jarayoni topilmadi.');
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
  }
  ctx.session.joinWelcomeDraft.buttons = [];
  return ctx.reply('Havolali tugmalar olib tashlandi.', joinWelcomeDraftKeyboard());
});

bot.action(/^join_welcome:color:(blue|green|red)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.joinWelcomeDraft || ctx.session.step !== 'join_welcome_button_color') {
    return ctx.reply('Tugma rangini tanlash bosqichi topilmadi.');
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
  }
  const style = { blue: 'primary', green: 'success', red: 'danger' }[ctx.match[1]];
  ctx.session.joinWelcomeDraft.buttons.push([{
    text: ctx.session.pendingJoinWelcomeButtonText,
    url: ctx.session.pendingJoinWelcomeButtonUrl,
    style
  }]);
  delete ctx.session.pendingJoinWelcomeButtonText;
  delete ctx.session.pendingJoinWelcomeButtonUrl;
  ctx.session.step = 'join_welcome_controls';
  return ctx.reply('Tugma qo\'shildi. Preview ko\'ring yoki saqlang.', joinWelcomeDraftKeyboard());
});

bot.action('join_welcome:preview', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.joinWelcomeDraft || ctx.session.step !== 'join_welcome_controls') {
    return ctx.reply('Avval salomlashuv matnini kiriting.');
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
  }
  try {
    await sendJoinWelcomeMessage(ctx.telegram, ctx.from.id, chat, ctx.session.joinWelcomeDraft);
    return ctx.reply('Yuqoridagi xabar — preview. Saqlash tugmasini bossangiz, shu chatga kelgan barcha ariza beruvchilarga yuboriladi.', joinWelcomeDraftKeyboard());
  } catch (error) {
    console.error(`Join-request welcome preview failed for chat ${chat.chatId}:`, error.response?.description || error.message);
    return ctx.reply(`Preview yuborilmadi: ${error.response?.description || error.message}`, joinWelcomeDraftKeyboard());
  }
});

bot.action('join_welcome:save', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session?.joinWelcomeDraft || ctx.session.step !== 'join_welcome_controls') {
    return ctx.reply('Avval salomlashuv matnini kiriting.');
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
  }
  const draft = ctx.session.joinWelcomeDraft;
  await JoinRequestChat.updateOne({ chatId: chat.chatId }, {
    $set: {
      welcomeMessage: draft.message,
      welcomeEntities: draft.entities,
      welcomeMediaType: draft.mediaType,
      welcomeMediaFileId: draft.mediaFileId,
      welcomeButtons: draft.buttons
    }
  });
  reset(ctx);
  return ctx.reply('✅ Salomlashuv saqlandi. Shu chatga ariza yuborganlarga bu xabar yuboriladi.');
});

bot.action('join_welcome:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  reset(ctx);
  return ctx.reply('Salomlashuvni tahrirlash bekor qilindi.');
});

async function discardFailedJoinRequest(chatId, userId, source) {
  try {
    await PendingJoinRequest.deleteOne({ chatId, userId });
  } catch (error) {
    console.error(
      `Could not remove failed join request ${chatId}/${userId} (${source}):`,
      error.response?.description || error.message
    );
  }
}

bot.action(/^join_chat:approve_all:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply(chat === null ? 'Ulangan chat topilmadi.' : 'Bu chatni boshqarish uchun uning administratori bo\'lishingiz kerak.');

  const requests = await PendingJoinRequest.find({ chatId }, { userId: 1 }).sort({ requestedAt: 1 }).lean();
  if (!requests.length) {
    return ctx.reply('Qabul qilinadigan kutilayotgan so\'rov yo\'q.', chatManagementKeyboard(chat, 0));
  }
  if (pendingBulkJoinApprovals.has(String(chatId))) {
    return ctx.reply('Bu chat uchun ommaviy qabul allaqachon bajarilmoqda.');
  }
  pendingBulkJoinApprovals.add(String(chatId));

  try {
    let nextIndex = 0;
    let approved = 0;
    let failed = 0;
    const workerCount = Math.min(5, requests.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < requests.length) {
        const request = requests[nextIndex];
        nextIndex += 1;
        try {
          await ctx.telegram.approveChatJoinRequest(chatId, request.userId);
          await PendingJoinRequest.deleteOne({ chatId, userId: request.userId });
          approved += 1;
        } catch (error) {
          failed += 1;
          console.error(`Bulk join request approval failed for ${chatId}/${request.userId}:`, error.response?.description || error.message);
        }
      }
    });
    await Promise.all(workers);

    const pendingCount = await PendingJoinRequest.countDocuments({ chatId });
    return ctx.reply(
      `Ommaviy qabul yakunlandi.\nQabul qilindi: ${approved}\nXatolik: ${failed}\nNavbatda qoldi: ${pendingCount}`,
      chatManagementKeyboard(chat, pendingCount)
    );
  } finally {
    pendingBulkJoinApprovals.delete(String(chatId));
  }
});

bot.action(/^join_chat:requests:(-?\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return showJoinRequestQueue(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
});

bot.action(/^join_chat:unlink:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply(chat === null ? 'Ulangan chat topilmadi.' : 'Bu chatni boshqarish uchun uning administratori bo\'lishingiz kerak.');
  await JoinRequestChat.deleteOne({ chatId });
  joinRequestChatIds.delete(String(chatId));
  return ctx.reply('Chat uzildi. Kutilayotgan so\'rovlar avtomatik qabul qilinmaydi.', {
    reply_markup: Markup.inlineKeyboard([[
      Markup.button.callback('⬅️ Chatlarim', 'join_chat:list')
    ]]).reply_markup
  });
});

bot.action(/^join_request:approve:(-?\d+):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = Number(ctx.match[1]);
  const userId = Number(ctx.match[2]);
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply(chat === null ? 'Ulangan chat topilmadi.' : 'Bu chatni boshqarish uchun uning administratori bo\'lishingiz kerak.');
  try {
    await ctx.telegram.approveChatJoinRequest(chatId, userId);
    await PendingJoinRequest.deleteOne({ chatId, userId });
  } catch (error) {
    console.error(`Join request approval failed for ${chatId}/${userId}:`, error.response?.description || error.message);
    return ctx.reply(`So\'rovni qabul qilib bo\'lmadi: ${error.response?.description || error.message}`);
  }
  return showJoinRequestQueue(ctx, chatId, Number(ctx.match[3]));
});

bot.action(/^join_chat:remove:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || !hasPermission(ctx, 'join_requests')) return ctx.reply('Ruxsat yo\'q.');
  return ctx.reply('Boshqa foydalanuvchilar ulagan chatlarni admin paneldan boshqarib bo\'lmaydi. Jami sonini statistika bo\'limida ko\'ring.', adminKeyboard(ctx));
});

bot.on('chat_join_request', async (ctx) => {
  const request = ctx.chatJoinRequest;
  if (!request) return;
  const approvalKey = `${request.chat.id}:${request.from.id}`;
  if (pendingJoinApprovals.has(approvalKey)) return;
  pendingJoinApprovals.add(approvalKey);
  let approvalAttempted = false;

  try {
    const linkedChat = await JoinRequestChat.findOne(
      { chatId: request.chat.id },
      {
        paused: 1,
        title: 1,
        username: 1,
        welcomeMessage: 1,
        welcomeEntities: 1,
        welcomeMediaType: 1,
        welcomeMediaFileId: 1,
        welcomeButtons: 1
      }
    ).lean();
    if (!linkedChat) return;

    const requestFields = {
      username: request.from.username || '',
      firstName: request.from.first_name || '',
      lastName: request.from.last_name || '',
      requestedAt: request.date ? new Date(request.date * 1000) : new Date(),
      receivedAt: new Date()
    };
    try {
      await PendingJoinRequest.findOneAndUpdate(
        { chatId: request.chat.id, userId: request.from.id },
        { $set: requestFields },
        { upsert: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      await PendingJoinRequest.updateOne(
        { chatId: request.chat.id, userId: request.from.id },
        { $set: requestFields }
      );
    }
    try {
      await sendJoinWelcomeMessage(
        ctx.telegram,
        request.user_chat_id || request.from.id,
        { ...linkedChat, title: linkedChat.title || request.chat.title },
        {
          message: linkedChat.welcomeMessage || 'Sizni tez orada qabul qilamiz!',
          entities: linkedChat.welcomeEntities || [],
          mediaType: linkedChat.welcomeMediaType || '',
          mediaFileId: linkedChat.welcomeMediaFileId || '',
          buttons: linkedChat.welcomeButtons || []
        }
      );
    } catch (error) {
      console.error(`Join-request welcome delivery failed for user ${request.from.id}:`, error.response?.description || error.message);
    }
    if (!joinRequestChatIds.has(String(request.chat.id)) || linkedChat.paused) return;

    approvalAttempted = true;
    await ctx.telegram.approveChatJoinRequest(request.chat.id, request.from.id);
    await PendingJoinRequest.deleteOne({ chatId: request.chat.id, userId: request.from.id });
  } catch (error) {
    const retryAfter = Number(error.parameters?.retry_after || error.response?.parameters?.retry_after);
    if (error.code === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      try {
        const currentLink = await JoinRequestChat.findOne({ chatId: request.chat.id }, { paused: 1 }).lean();
        if (!currentLink || currentLink.paused) return;
        approvalAttempted = true;
        await ctx.telegram.approveChatJoinRequest(request.chat.id, request.from.id);
        await PendingJoinRequest.deleteOne({ chatId: request.chat.id, userId: request.from.id });
        return;
      } catch (retryError) {
        console.error(`Join request approval retry failed for chat ${request.chat.id}:`, retryError.response?.description || retryError.message);
        await discardFailedJoinRequest(request.chat.id, request.from.id, 'automatic approval retry');
        return;
      }
    }
    console.error(`Join request approval failed for chat ${request.chat.id}:`, error.response?.description || error.message);
    if (approvalAttempted) {
      await discardFailedJoinRequest(request.chat.id, request.from.id, 'automatic approval');
    }
  } finally {
    pendingJoinApprovals.delete(approvalKey);
  }
});

bot.action('check_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  if (await requiredSubscription(ctx)) return ctx.reply(welcomeMessage(ctx), replyOptions(welcomeMarkup(ctx) || userKeyboard(ctx).reply_markup));
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(configuredMessage('help', ctx), replyOptions());
});

function permissionForCallback(callbackData) {
  if (callbackData === 'admin:stats') return 'stats';
  if (callbackData === 'admin:admins' || callbackData === 'admin:add' || callbackData === 'admin:logs' || callbackData.startsWith('admin:manage:') || callbackData.startsWith('admin:perm:') || callbackData.startsWith('admin:remove:')) return 'admins';
  if (callbackData.startsWith('broadcast:')) return 'broadcast';
  if (callbackData === 'admin:join_chats' || callbackData.startsWith('join_chat:')) return 'join_requests';
  if (/^admin:(?:subscription|required_list|subscription_off)/.test(callbackData)) return 'settings';
  return null;
}

function getChatCommand(ctx) {
  return ctx.message?.text || ctx.channelPost?.text || '';
}

function isChatLinkCommand(text) {
  return /^\/(?:connect|disconnect)(?:@\w+)?(?:\s|$)/i.test(text);
}

function chatManagementKeyboard(chat, pendingCount) {
  const paused = Boolean(chat.paused);
  return Markup.inlineKeyboard([
    [Markup.button.callback(
      paused ? '▶️ So\'rovlarni davom ettirish' : '⏸ So\'rovlarni to\'xtatish',
      `join_chat:${paused ? 'resume' : 'pause'}:${chat.chatId}`
    )],
    [Markup.button.callback(
      `📨 Kutilayotgan so\'rovlar (${pendingCount})`,
      `join_chat:requests:${chat.chatId}:0`
    )],
    [Markup.button.callback('✅ Barchasini qabul qilish', `join_chat:approve_all:${chat.chatId}`)],
    [Markup.button.callback('✉️ Salomlashuvni tahrirlash', `join_chat:edit_welcome:${chat.chatId}`)],
    [Markup.button.callback('🔌 Chatni uzish', `join_chat:unlink:${chat.chatId}`)],
    [Markup.button.callback('⬅️ Chatlarim', 'join_chat:list')]
  ]);
}

function joinWelcomeMediaKeyboard(draft) {
  const rows = [];
  if (draft.mediaFileId) {
    rows.push([Markup.button.callback('✅ Mavjud mediani saqlash', 'join_welcome:keep_media')]);
  }
  rows.push([Markup.button.callback('📝 Mediasiz davom etish', 'join_welcome:no_media')]);
  rows.push([Markup.button.callback('❌ Bekor qilish', 'join_welcome:cancel')]);
  return Markup.inlineKeyboard(rows);
}

function joinWelcomeDraftKeyboard() {
  const rows = [
    [Markup.button.callback('➕ Havolali tugma qo\'shish', 'join_welcome:add_button')],
    [Markup.button.callback('🧹 Tugmalarni olib tashlash', 'join_welcome:clear_buttons')]
  ];
  rows.push(
    [Markup.button.callback('👁 Preview', 'join_welcome:preview'), Markup.button.callback('💾 Saqlash', 'join_welcome:save')],
    [Markup.button.callback('❌ Bekor qilish', 'join_welcome:cancel')]
  );
  return Markup.inlineKeyboard(rows);
}

function joinWelcomeColorKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔵 Ko\'k', 'join_welcome:color:blue'), Markup.button.callback('🟢 Yashil', 'join_welcome:color:green')],
    [Markup.button.callback('🔴 Qizil', 'join_welcome:color:red')]
  ]);
}

async function authorizeJoinWelcomeEdit(ctx) {
  const chatId = Number(ctx.session?.joinRequestChatId);
  if (!Number.isSafeInteger(chatId)) return null;
  return isChatAdministrator(ctx, chatId);
}

function prefixedWelcomeContent(chat, draft) {
  const prefix = `${chat.title || chat.username || 'Kanal'} ga xush kelibsiz. `;
  const message = String(draft.message || '');
  const entities = (draft.entities || []).map((entity) => ({
    ...entity,
    offset: entity.offset + prefix.length
  }));
  return { caption: `${prefix}${message}`, entities };
}

async function sendJoinWelcomeMessage(telegram, recipientId, chat, draft) {
  const { caption, entities } = prefixedWelcomeContent(chat, draft);
  const replyMarkup = draft.buttons?.length
    ? Markup.inlineKeyboard(draft.buttons).reply_markup
    : undefined;
  const common = replyMarkup ? { reply_markup: replyMarkup } : {};
  if (draft.mediaType === 'photo' && draft.mediaFileId) {
    return telegram.sendPhoto(recipientId, draft.mediaFileId, {
      ...common,
      caption,
      ...(entities.length ? { caption_entities: entities } : {})
    });
  }
  if (draft.mediaType === 'video' && draft.mediaFileId) {
    return telegram.sendVideo(recipientId, draft.mediaFileId, {
      ...common,
      caption,
      ...(entities.length ? { caption_entities: entities } : {})
    });
  }
  if (draft.mediaType === 'animation' && draft.mediaFileId) {
    return telegram.sendAnimation(recipientId, draft.mediaFileId, {
      ...common,
      caption,
      ...(entities.length ? { caption_entities: entities } : {})
    });
  }
  return telegram.sendMessage(recipientId, caption, {
    ...common,
    ...(entities.length ? { entities } : {})
  });
}

async function handleJoinWelcomeMedia(ctx, mediaType, fileId) {
  if (ctx.session?.step !== 'join_welcome_media') return false;
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Salomlashuv mediasini botning shaxsiy chatida yuboring.');
    return true;
  }
  const chat = await authorizeJoinWelcomeEdit(ctx);
  if (!chat) {
    reset(ctx);
    await ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
    return true;
  }
  const caption = ctx.message.caption || '';
  const prefixLength = `${chat.title || chat.username || 'Kanal'} ga xush kelibsiz. `.length;
  if (caption.length > 1024 - prefixLength) {
    await ctx.reply(`Media izohi ${Math.max(0, 1024 - prefixLength)} belgidan oshmasligi kerak. Media va izohni qayta yuboring.`);
    return true;
  }
  ctx.session.joinWelcomeDraft.mediaType = mediaType;
  ctx.session.joinWelcomeDraft.mediaFileId = fileId;
  ctx.session.joinWelcomeDraft.message = caption;
  ctx.session.joinWelcomeDraft.entities = ctx.message.caption_entities || [];
  ctx.session.step = caption ? 'join_welcome_controls' : 'join_welcome_text';
  if (caption) {
    await ctx.reply('Media va izoh qabul qilindi. Preview qiling yoki havolali tugma qo\'shing.', joinWelcomeDraftKeyboard());
  } else {
    await ctx.reply('Media qabul qilindi. Endi salomlashuv matnini yuboring (media izohi sifatida qo\'shiladi):');
  }
  return true;
}

async function isChatAdministrator(ctx, chatId) {
  const chat = await JoinRequestChat.findOne({ chatId }).lean();
  if (!chat) return null;
  try {
    const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
    if (['creator', 'administrator'].includes(member.status)) return chat;
  } catch (error) {
    console.error(`Chat admin verification failed for ${chatId}:`, error.response?.description || error.message);
  }
  return false;
}

async function showJoinRequestChats(ctx) {
  const ownerChats = await JoinRequestChat.find({ linkedBy: ctx.from.id }).sort({ createdAt: -1 }).limit(50).lean();
  if (!ownerChats.length) {
    return ctx.reply('Hali sizga ulangan chat yo\'q. Botni chatga administrator qiling va /connect buyrug\'ini yuboring.');
  }
  const syncErrors = [];
  for (const chat of ownerChats) {
    try {
      await syncJoinRequestArchive(ctx.from.id, chat);
    } catch (error) {
      syncErrors.push(chat.title || chat.username || String(chat.chatId));
      console.error(`Could not sync pending join requests for ${chat.chatId}:`, error.message);
    }
  }
  const pendingCounts = await PendingJoinRequest.aggregate([
    { $match: { chatId: { $in: ownerChats.map((chat) => chat.chatId) } } },
    { $group: { _id: '$chatId', count: { $sum: 1 } } }
  ]);
  const countsByChat = new Map(pendingCounts.map((item) => [item._id, item.count]));
  const buttons = ownerChats.map((chat) => {
    const pendingCount = countsByChat.get(chat.chatId) || 0;
    const suffix = pendingCount ? ` · 📨 ${pendingCount}` : '';
    const title = (chat.title || chat.username || String(chat.chatId)).slice(0, Math.max(1, 48 - suffix.length));
    return [Markup.button.callback(
      `${chat.paused ? '⏸' : '▶️'} ${title}${suffix}`,
      `join_chat:open:${chat.chatId}`
    )];
  });
  const warning = syncErrors.length
    ? `\n\n⚠️ Ayrim chatlarning eski so\'rovlarini yangilab bo\'lmadi: ${syncErrors.join(', ')}`
    : '';
  return ctx.reply(`Boshqarish uchun kanal yoki guruhni tanlang:${warning}`, Markup.inlineKeyboard(buttons));
}

async function showJoinRequestQueue(ctx, chatId, page = 0) {
  const chat = await isChatAdministrator(ctx, chatId);
  if (!chat) return ctx.reply(chat === null ? 'Ulangan chat topilmadi.' : 'Bu chatni boshqarish uchun uning administratori bo\'lishingiz kerak.');
  let syncWarning = '';
  try {
    await syncJoinRequestArchive(ctx.from.id, chat);
  } catch (error) {
    syncWarning = '\n\n⚠️ Eski so\'rovlarni yangilab bo\'lmadi. Avvaldan saqlangan so\'rovlar ko\'rsatilmoqda.';
    console.error(`Could not sync pending join requests for ${chatId}:`, error.message);
  }
  const total = await PendingJoinRequest.countDocuments({ chatId });
  if (!total) {
    const message = !telegramAccountManager.isConfigured()
      ? `Saqlangan kutilayotgan so\'rovlar yo\'q.${syncWarning}\n\nBot egasi Telegram API va sessiya shifrlash sozlamalarini kiritishi kerak.`
      : await telegramAccountManager.isLinked(ctx.from.id)
        ? `Kutilayotgan qo\'shilish so\'rovlari yo\'q.${syncWarning}`
        : `Saqlangan kutilayotgan so\'rovlar yo\'q.${syncWarning}\n\nEski so\'rovlarni ko\'rish uchun avval /telegram_login orqali o\'z Telegram akkauntingizni ulang.`;
    return ctx.reply(message, chatManagementKeyboard(chat, 0));
  }

  const pageSize = 8;
  const pageCount = Math.ceil(total / pageSize);
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const requests = await PendingJoinRequest.find({ chatId })
    .sort({ requestedAt: 1 })
    .skip(currentPage * pageSize)
    .limit(pageSize)
    .lean();

  const rows = [
    [Markup.button.callback('✅ Barchasini qabul qilish', `join_chat:approve_all:${chatId}`)],
    ...requests.map((request) => {
      const name = [request.firstName, request.lastName].filter(Boolean).join(' ') ||
        (request.username ? `@${request.username}` : String(request.userId));
      const label = `${name}${request.username ? ` (@${request.username})` : ''}`.slice(0, 50);
      return [Markup.button.callback(`✅ ${label}`, `join_request:approve:${chatId}:${request.userId}:${currentPage}`)];
    })
  ];
  const navigation = [];
  if (currentPage > 0) navigation.push(Markup.button.callback('⬅️ Oldingi', `join_chat:requests:${chatId}:${currentPage - 1}`));
  if (currentPage + 1 < pageCount) navigation.push(Markup.button.callback('Keyingi ➡️', `join_chat:requests:${chatId}:${currentPage + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([Markup.button.callback('⬅️ Chat boshqaruvi', `join_chat:open:${chatId}`)]);
  return ctx.reply(
    `Kutilayotgan so\'rovlar jami: ${total} (sahifa ${currentPage + 1}/${pageCount})${syncWarning}`,
    Markup.inlineKeyboard(rows)
  );
}

async function syncJoinRequestArchive(telegramId, chat) {
  const requests = await telegramAccountManager.getPendingRequests(telegramId, chat);
  if (!requests) return;
  const userIds = requests.map((request) => request.userId);
  for (const request of requests) {
    await PendingJoinRequest.findOneAndUpdate(
      { chatId: chat.chatId, userId: request.userId },
      { $set: {
        username: request.username,
        firstName: request.firstName,
        lastName: request.lastName,
        requestedAt: request.requestedAt,
        receivedAt: new Date()
      } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  if (requests.length < 5000) {
    await PendingJoinRequest.deleteMany({ chatId: chat.chatId, userId: { $nin: userIds } });
  }
}

async function verifyJoinRequestChat(ctx, chat, actorId) {
  if (!['channel', 'group', 'supergroup'].includes(chat.type)) {
    throw new Error('Faqat kanal yoki guruhni ulash mumkin.');
  }

  if (actorId) {
    const actor = await ctx.telegram.getChatMember(chat.id, actorId);
    if (!['creator', 'administrator'].includes(actor.status)) {
      throw new Error('Ulash uchun ushbu chatda administrator bo\'lishingiz kerak.');
    }
  }

  const botMember = await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
  if (botMember.status === 'creator') return;
  if (botMember.status !== 'administrator') {
    throw new Error('Avval botni ushbu chatga administrator qilib qo\'shing.');
  }
  if (botMember.can_invite_users !== true) {
    throw new Error('Bot administratoriga foydalanuvchilarni taklif qilish huquqini bering.');
  }
  if (botMember.can_delete_messages !== true) {
    throw new Error('Kanal/guruhdagi /connect va /disconnect xabarlarini o\'chirish uchun botga xabarlarni o\'chirish huquqini bering.');
  }
}

async function replyPrivatelyAndDelete(ctx, chat, messageId, userId, message) {
  try {
    await ctx.telegram.deleteMessage(chat.id, messageId);
  } catch (error) {
    console.error(`Could not delete command message in chat ${chat.id}:`, error.response?.description || error.message);
  }
  if (!userId) return;
  try {
    await ctx.telegram.sendMessage(userId, message, { protect_content: true });
  } catch (error) {
    console.error(`Private command response failed for user ${userId}:`, error.response?.description || error.message);
  }
}

async function handleJoinChatCommand(ctx, command, chat, actorId, channelPost = false) {
  let notifyUserId = actorId;
  if (channelPost) {
    const linkedChat = await JoinRequestChat.findOne({ chatId: chat.id }, { linkedBy: 1 }).lean();
    notifyUserId = linkedChat?.linkedBy || null;
  }

  const respond = async (message) => {
    if (!channelPost && ctx.chat?.type === 'private') return ctx.reply(message);
    const messageId = channelPost ? ctx.channelPost.message_id : ctx.message?.message_id;
    if (messageId) {
      try {
        await ctx.telegram.deleteMessage(chat.id, messageId);
      } catch (error) {
        console.error(`Could not delete ${command} message in chat ${chat.id}:`, error.response?.description || error.message);
      }
    }
    if (!notifyUserId) {
      console.warn(`Cannot privately notify the author of ${command} in channel ${chat.id}; link the channel from a private chat first.`);
      return;
    }
    try {
      await ctx.telegram.sendMessage(notifyUserId, message, { protect_content: true });
    } catch (error) {
      console.error(`Private notification for ${command} in channel ${chat.id} failed:`, error.response?.description || error.message);
    }
  };

  try {
    if (command.toLowerCase().startsWith('/connect')) {
      if (channelPost && !notifyUserId) {
        return respond('Kanalni ulash uchun botning shaxsiy chatida /connect yuborib, olgan 6 xonali kodingizni kanalda /connect 123456 shaklida yuboring.');
      }
      await verifyJoinRequestChat(ctx, chat, actorId);
      const fields = {
        title: chat.title || chat.username || String(chat.id),
        type: chat.type,
        username: chat.username ? `@${chat.username}` : ''
      };
      if (actorId) fields.linkedBy = actorId;
      await JoinRequestChat.findOneAndUpdate(
        { chatId: chat.id },
        { $set: fields, $setOnInsert: { paused: false } },
        { upsert: true, setDefaultsOnInsert: true, returnDocument: 'after' }
      );
      joinRequestChatIds.add(String(chat.id));
      if (actorId && ctx.chat.type === 'private') {
        return respond('✅ Chat ulandi. So\'rovlarni boshqarish uchun /mychats buyrug\'idan foydalaning.');
      }
      if (!actorId) {
        return respond('✅ Kanal yangilandi. So\'rovlarni boshqarish uchun botning shaxsiy chatida /mychats buyrug\'ini yuboring.');
      }
      return respond('✅ Chat ulandi. So\'rovlarni botning shaxsiy chatida /mychats buyrug\'i orqali boshqaring.');
    }

    if (actorId) {
      const actor = await ctx.telegram.getChatMember(chat.id, actorId);
      if (!['creator', 'administrator'].includes(actor.status)) {
        return respond('Ulashni bekor qilish uchun ushbu chatda administrator bo\'lishingiz kerak.');
      }
    }
    const result = await JoinRequestChat.deleteOne({ chatId: chat.id });
    joinRequestChatIds.delete(String(chat.id));
    return respond(result.deletedCount
      ? 'Chat uzildi. Yangi qo\'shilish so\'rovlari avtomatik qabul qilinmaydi.'
      : 'Bu chat botga ulanmagan edi.');
  } catch (error) {
    console.error(`Join-request chat ${command} failed for ${chat.id}:`, error.response?.description || error.message);
    return respond(error.message || 'Chatni ulashda xatolik yuz berdi.');
  }
}

async function handleChannelLinkCommand(ctx) {
  const text = getChatCommand(ctx);
  if (!isChatLinkCommand(text)) return;
  if (/^\/connect(?:@\w+)?(?:\s|$)/i.test(text)) {
    return handleJoinRequestConnectCode(ctx, text);
  }
  return handleJoinChatCommand(ctx, text, ctx.channelPost.chat, null, true);
}

function hashJoinRequestLinkCode(code) {
  return crypto.createHmac('sha256', config.botToken).update(code).digest('hex');
}

async function issueJoinRequestLinkCode(ctx) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = hashJoinRequestLinkCode(code);
    try {
      await JoinRequestLinkCode.findOneAndUpdate(
        { telegramId: ctx.from.id },
        { $set: { codeHash, expiresAt, claimedAt: null, claimedChatId: null } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      return ctx.reply(
        `Bir martalik kanal ulash kodi: <code>${code}</code>\n\n` +
        `10 daqiqa ichida bot administrator bo\'lgan kanal yoki guruhga /connect ${code} yuboring. ` +
        `Kodni boshqalarga bermang. Chat ulanganidan keyin natijani shu shaxsiy chatga yuboraman.`,
        { parse_mode: 'HTML', protect_content: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  throw new Error('Bir martalik kod yaratib bo\'lmadi. Birozdan keyin qayta urinib ko\'ring.');
}

async function handleJoinRequestConnectCode(ctx, command) {
  const chat = ctx.chat;
  const message = ctx.channelPost || ctx.message;
  const actorId = ctx.from?.id;
  const code = command.replace(/^\/connect(?:@\w+)?\s*/i, '').trim();
  let challenge;
  let linkSaved = false;

  try {
    if (!/^\d{6}$/.test(code)) {
      return replyPrivatelyAndDelete(ctx, chat, message.message_id, actorId,
        'Kanal/guruh ulash kodi 6 ta raqamdan iborat bo\'lishi kerak. Botning shaxsiy chatida /connect yuborib yangi kod oling.');
    }

    try {
      await ctx.telegram.deleteMessage(chat.id, message.message_id);
    } catch (error) {
      console.error(`Could not delete /connect code in chat ${chat.id}:`, error.response?.description || error.message);
    }

    challenge = await JoinRequestLinkCode.findOneAndUpdate(
      {
        codeHash: hashJoinRequestLinkCode(code),
        expiresAt: { $gt: new Date() },
        claimedAt: null
      },
      { $set: { claimedAt: new Date(), claimedChatId: chat.id } },
      { returnDocument: 'after' }
    ).lean();

    if (!challenge) {
      console.warn(`Invalid or expired chat connection code submitted in chat ${chat.id}.`);
      if (actorId) {
        try {
          await ctx.telegram.sendMessage(actorId, 'Kod yaroqsiz yoki muddati tugagan. Botning shaxsiy chatida /connect yuborib yangi kod oling.');
        } catch (error) {
          console.error(`Invalid-code notification failed for user ${actorId}:`, error.response?.description || error.message);
        }
      }
      return;
    }

    await verifyJoinRequestChat(ctx, chat, challenge.telegramId);
    const consumedCode = await JoinRequestLinkCode.deleteOne({
      _id: challenge._id,
      claimedChatId: chat.id
    });
    if (consumedCode.deletedCount !== 1) {
      throw new Error('Kod muddati tugagan yoki allaqachon ishlatilgan. Yangi /connect kodi oling.');
    }
    await JoinRequestChat.findOneAndUpdate(
      { chatId: chat.id },
      {
        $set: {
          title: chat.title || chat.username || String(chat.id),
          type: chat.type,
          username: chat.username ? `@${chat.username}` : '',
          linkedBy: challenge.telegramId
        },
        $setOnInsert: { paused: false }
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    linkSaved = true;
    joinRequestChatIds.add(String(chat.id));
    await ctx.telegram.sendMessage(
      challenge.telegramId,
      `✅ “${chat.title || chat.username || chat.id}” chat ulandi. Ulanish tasdiqlandi: siz chat egasi yoki administratorisiz. Boshqarish uchun /mychats yuboring.`,
      { protect_content: true }
    );
  } catch (error) {
    if (challenge) {
      if (!linkSaved) {
        await JoinRequestLinkCode.updateOne(
          { _id: challenge._id, claimedChatId: chat.id },
          { $set: { claimedAt: null, claimedChatId: null } }
        );
      }
      try {
        await ctx.telegram.sendMessage(
          challenge.telegramId,
          linkSaved
            ? '✅ Kanal ulandi, lekin tasdiq xabarini yuborib bo\'lmadi. /mychats orqali tekshiring.'
            : `❌ Kanalni ulab bo\'lmadi: ${error.message || 'xatolik yuz berdi'}. Bot adminligi va kerakli huquqlarni tekshirib, yangi kod oling.`,
          { protect_content: true }
        );
      } catch (notifyError) {
        console.error(`Private channel-link failure notification failed for ${challenge.telegramId}:`, notifyError.response?.description || notifyError.message);
      }
    }
    console.error(`Channel connect code failed for ${chat.id}:`, error.response?.description || error.message);
  }
}

bot.hears(/^(?:Admin panel|🛠 Admin panel)$/, (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  activateAdminPanel(ctx);
  return ctx.reply('Admin panel', adminKeyboard(ctx));
});

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  activateAdminPanel(ctx);
  return ctx.reply('Admin panel', adminKeyboard(ctx));
});

bot.action('admin:stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  return adminStats(ctx);
});

bot.action('admin:panel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  activateAdminPanel(ctx);
  return ctx.reply('Admin panel', adminKeyboard(ctx));
});

bot.action('admin:exit', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  reset(ctx);
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (error) {
    console.warn('Admin panel close failed:', error.response?.description || error.message);
  }
  return ctx.reply(welcomeMessage(ctx), replyOptions(welcomeMarkup(ctx)));
});

bot.action('admin:admins', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const admins = await Admin.find({ active: true }).sort({ createdAt: 1 }).lean();
  const text = admins.length
    ? admins.map((admin, index) => `${index + 1}. ${admin.nickname || admin.username || admin.telegramId} - ${permissionsLabel(admin.permissions)}`).join('\n')
    : 'Hali qo\'shimcha adminlar yo\'q.';
  const rows = admins.map((admin) => [Markup.button.callback(
    `⚙️ ${admin.nickname || admin.username || admin.telegramId}`, `admin:manage:${admin.telegramId}`
  )]);
  rows.push([Markup.button.callback('➕ Admin qo\'shish', 'admin:add')]);
  rows.push([Markup.button.callback('⬅️ Admin panel', 'admin:panel')]);
  return ctx.reply(`👥 Adminlar\n\n${text}`, Markup.inlineKeyboard(rows));
});

bot.action('admin:logs', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const logs = await AdminLog.find({}).sort({ createdAt: -1 }).limit(20).lean();
  if (!logs.length) return ctx.reply('Hali admin amallari qayd etilmagan.', adminKeyboard(ctx));
  const text = logs.map((log, index) => {
    const date = new Date(log.createdAt).toLocaleString('uz-UZ', { timeZone: config.timezone });
    return `${index + 1}. ${log.adminName || log.adminTelegramId}\n${log.action}${log.details ? ` - ${log.details}` : ''}\n${date}`;
  }).join('\n\n');
  return ctx.reply(`🧾 Oxirgi admin amallari\n\n${text}`, adminKeyboard(ctx));
});

bot.action('admin:add', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  ctx.session = { step: 'admin_add', adminPanelActive: true };
  return ctx.reply('Qo\'shiladigan adminning Telegram ID raqamini yuboring:');
});

bot.action(/^admin:manage:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const admin = await Admin.findOne({ telegramId: Number(ctx.match[1]), active: true }).lean();
  if (!admin) return ctx.reply('Admin topilmadi.', adminKeyboard(ctx));
  return ctx.reply(
    `Admin: ${admin.nickname || admin.username || admin.telegramId}\nID: ${admin.telegramId}\nHuquqlar: ${permissionsLabel(admin.permissions)}`,
    adminManagementKeyboard(admin)
  );
});

bot.action(/^admin:perm:(\d+):(broadcast|stats|settings|join_requests|admins)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const telegramId = Number(ctx.match[1]);
  const permission = ctx.match[2];
  const admin = await Admin.findOne({ telegramId, active: true });
  if (!admin) return ctx.reply('Admin topilmadi.', adminKeyboard(ctx));
  admin.permissions = admin.permissions.includes(permission)
    ? admin.permissions.filter((item) => item !== permission)
    : [...admin.permissions, permission];
  await admin.save();
  adminRegistry.set(telegramId, admin.toObject());
  await logAdminAction(ctx, 'admin_permission_changed', `${telegramId}: ${permission}`);
  return ctx.reply(`Huquq yangilandi.\n\nHuquqlar: ${permissionsLabel(admin.permissions)}`, adminManagementKeyboard(admin));
});

bot.action(/^admin:remove:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const telegramId = Number(ctx.match[1]);
  await Admin.updateOne({ telegramId }, { $set: { active: false } });
  adminRegistry.delete(telegramId);
  await logAdminAction(ctx, 'admin_removed', String(telegramId));
  return ctx.reply('Admin o\'chirildi.', adminKeyboard(ctx));
});

bot.action('admin:broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  ctx.session = { step: 'broadcast_media', broadcast: { buttons: [] }, adminPanelActive: true };
  return ctx.reply('<tg-emoji emoji-id="5350693961281314631">🖼</tg-emoji> Xabar uchun rasm, video yoki GIF yuboring. Media shart emas:', replyOptions(broadcastKeyboard().reply_markup));
});

bot.action('broadcast:no_media', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') return ctx.reply('Broadcast jarayoni topilmadi.');
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('<tg-emoji emoji-id="5393314064220843793">💬</tg-emoji> Xabar matnini yuboring. Premium emoji uchun HTML teglaridan foydalanishingiz mumkin:', replyOptions());
});

bot.action('broadcast:add_button', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_buttons') return ctx.reply('Avval xabar matnini kiriting.');
  ctx.session.step = 'broadcast_button_text';
  return ctx.reply('Inline tugma matnini yuboring:');
});

bot.action('broadcast:preview', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_buttons') return ctx.reply('Avval xabarni tayyorlang.');
  return previewBroadcast(ctx);
});

bot.action(/^broadcast:color:(blue|green|red)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_button_color') return ctx.reply('Tugma rangi tanlash bosqichi topilmadi.');
  const style = { blue: 'primary', green: 'success', red: 'danger' }[ctx.match[1]];
  ctx.session.broadcast.buttons.push([{
    text: ctx.session.pendingButtonText,
    url: ctx.session.pendingButtonUrl,
    style
  }]);
  ctx.session.pendingButtonText = undefined;
  ctx.session.pendingButtonUrl = undefined;
  ctx.session.step = 'broadcast_buttons';
  return ctx.reply('Tugma qo\'shildi. Yana tugma qo\'shasizmi?', broadcastButtonKeyboard());
});

bot.action('broadcast:send', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || !ctx.session?.broadcast?.previewed) return ctx.reply('Avval Preview tugmasini bosing.');
  const result = await sendBroadcast(ctx);
  await logAdminAction(ctx, 'broadcast_sent', `total=${result.total}, sent=${result.sent}, failed=${result.failed}`);
  reset(ctx);
  return ctx.reply(`Xabar yuborildi.\nJami: ${result.total}\nYetib bordi: ${result.sent}\nBloklagan: ${result.blocked}\nXatolik: ${result.failed}`, adminKeyboard(ctx));
});

bot.action('broadcast:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  reset(ctx);
  return ctx.reply('Xabar yuborish bekor qilindi.', adminKeyboard(ctx));
});

bot.action('admin:subscription', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  ctx.session = { step: 'required_subscription_channel', adminPanelActive: true };
  return ctx.reply('Majburiy obuna kanalining public username sini yuboring, masalan: @my_channel');
});

bot.action('welcome:required_add', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu amalni bajarishi mumkin.');
  ctx.session = { step: 'required_subscription_channel', adminPanelActive: true };
  return ctx.reply('Majburiy obuna kanalining public username sini yuboring, masalan: @my_channel');
});

bot.action('welcome:join_chat_connect', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.chat?.type !== 'private') {
    return ctx.reply('Kanal yoki guruh ulash kodini olish uchun botning shaxsiy chatida ushbu tugmani bosing.');
  }
  return issueJoinRequestLinkCode(ctx);
});

bot.action('welcome:required_list', async (ctx) => {
  await ctx.answerCbQuery();
  return showJoinRequestChats(ctx);
});

bot.action('admin:required_list', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const channels = await getRequiredChannels();
  if (!channels.length) return ctx.reply('Majburiy obuna kanallari yo\'q.', adminKeyboard(ctx));
  return ctx.reply(channels.map((channel, index) => `${index + 1} - kanal: ${channel.title || channel.username}`).join('\n'), adminKeyboard(ctx));
});

bot.action('admin:subscription_off', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  data.settings.requiredChannels = [];
  await saveSettings();
  return ctx.reply('Majburiy obuna o\'chirildi.', adminKeyboard(ctx));
});

bot.on('video', async (ctx) => {
  if (await handleJoinWelcomeMedia(ctx, 'video', ctx.message.video.file_id)) return;
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') {
    return ctx.reply('Bu turdagi media xabar qabul qilinmaydi.');
  }
  ctx.session.broadcast.mediaType = 'video';
  ctx.session.broadcast.media = ctx.message.video.file_id;
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('Media uchun izoh yuboring:');
});

bot.on('photo', async (ctx) => {
  if (await handleJoinWelcomeMedia(ctx, 'photo', ctx.message.photo.at(-1).file_id)) return;
  if (isAdmin(ctx) && ctx.session?.step === 'broadcast_media') {
    ctx.session.broadcast.mediaType = 'photo';
    ctx.session.broadcast.media = ctx.message.photo.at(-1).file_id;
    ctx.session.step = 'broadcast_caption';
    return ctx.reply('Media uchun izoh yuboring:');
  }
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') {
    return ctx.reply('Bu turdagi media xabar qabul qilinmaydi.');
  }
  ctx.session.broadcast.mediaType = 'photo';
  ctx.session.broadcast.media = ctx.message.photo.at(-1).file_id;
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('Media uchun izoh yuboring:');
});

bot.on('animation', async (ctx) => {
  if (await handleJoinWelcomeMedia(ctx, 'animation', ctx.message.animation.file_id)) return;
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') {
    return ctx.reply('Bu turdagi media xabar qabul qilinmaydi.');
  }
  ctx.session.broadcast.mediaType = 'animation';
  ctx.session.broadcast.media = ctx.message.animation.file_id;
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('Media uchun izoh yuboring:');
});

bot.on('text', async (ctx) => {
  const rawText = ctx.message.text;
  const value = rawText.trim();
  const step = ctx.session?.step;
  if (await telegramAccountManager.handleInput(ctx)) return;
  if (step === 'join_welcome_text') {
    if (value.toLowerCase() === '/cancel') {
      reset(ctx);
      return ctx.reply('Salomlashuv matnini tahrirlash bekor qilindi.');
    }
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('Salomlashuv matnini botning shaxsiy chatida yuboring yoki /cancel bosing.');
    }
    if (value.startsWith('/')) {
      return ctx.reply('Matn yuboring yoki /cancel bosing.');
    }
    const chat = await authorizeJoinWelcomeEdit(ctx);
    if (!chat) {
      reset(ctx);
      return ctx.reply('Chatni boshqarish huquqingiz yo\'q yoki chat uzilgan.');
    }
    const draft = ctx.session.joinWelcomeDraft;
    if (!draft) {
      reset(ctx);
      return ctx.reply('Salomlashuv tahrirlash muddati tugagan. Qaytadan boshlang.');
    }
    const prefixLength = `${chat.title || chat.username || 'Kanal'} ga xush kelibsiz. `.length;
    const maxLength = (draft.mediaFileId ? 1024 : 4096) - prefixLength;
    if (!value || rawText.length > maxLength) {
      return ctx.reply(`Salomlashuv 1–${maxLength} belgi bo\'lishi kerak. Qayta yuboring yoki /cancel bosing.`);
    }
    draft.message = rawText;
    draft.entities = ctx.message.entities || [];
    ctx.session.step = 'join_welcome_controls';
    return ctx.reply('Salomlashuv tayyor. Avval preview qilib, so\'ng saqlashingiz mumkin.', joinWelcomeDraftKeyboard());
  }
  if (step === 'join_welcome_button_text') {
    if (value.toLowerCase() === '/cancel') {
      ctx.session.step = 'join_welcome_controls';
      return ctx.reply('Tugma qo\'shish bekor qilindi.', joinWelcomeDraftKeyboard());
    }
    if (!value || value.length > 64 || value.startsWith('/')) {
      return ctx.reply('Tugma matni 1–64 belgi bo\'lishi kerak:');
    }
    ctx.session.pendingJoinWelcomeButtonText = value;
    ctx.session.step = 'join_welcome_button_url';
    return ctx.reply('Tugma havolasini yuboring (http:// yoki https://):');
  }
  if (step === 'join_welcome_button_url') {
    if (value.toLowerCase() === '/cancel') {
      delete ctx.session.pendingJoinWelcomeButtonText;
      ctx.session.step = 'join_welcome_controls';
      return ctx.reply('Tugma qo\'shish bekor qilindi.', joinWelcomeDraftKeyboard());
    }
    if (!isHttpUrl(value)) return ctx.reply('Havola http:// yoki https:// bilan boshlanishi kerak. Qayta yuboring:');
    ctx.session.pendingJoinWelcomeButtonUrl = value;
    ctx.session.step = 'join_welcome_button_color';
    return ctx.reply('Tugma rangini tanlang:', joinWelcomeColorKeyboard());
  }
  if (value.startsWith('/')) {
    reset(ctx);
    return ctx.reply(isAdmin(ctx) ? 'Bu command mavjud emas.' : 'Bu command mavjud emas.');
  }
  if (/^(?:Admin panel|🛠 Admin panel)$/.test(value)) {
    if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
    activateAdminPanel(ctx);
    return ctx.reply('Admin panel', adminKeyboard(ctx));
  }
  if (step === 'broadcast_caption') {
    ctx.session.broadcast.caption = rawText;
    ctx.session.broadcast.captionEntities = ctx.message.entities || [];
    ctx.session.step = 'broadcast_buttons';
    return ctx.reply('Inline tugma qo\'shasizmi?', broadcastButtonKeyboard());
  }
  if (step === 'broadcast_button_text') {
    ctx.session.pendingButtonText = value;
    ctx.session.step = 'broadcast_button_url';
    return ctx.reply('Tugma havolasini yuboring (https://...):');
  }
  if (step === 'broadcast_button_url') {
    if (!isHttpUrl(value)) return ctx.reply('Havola http:// yoki https:// bilan boshlanishi kerak. Qayta yuboring:');
    ctx.session.pendingButtonUrl = value;
    ctx.session.step = 'broadcast_button_color';
    return ctx.reply('Tugma rangini tanlang:', broadcastColorKeyboard());
  }
  if (step === 'admin_add') {
    if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin yangi admin qo\'sha oladi.');
    if (!/^\d+$/.test(value)) return ctx.reply('Telegram ID faqat raqamlardan iborat bo\'lishi kerak:');
    const telegramId = Number(value);
    if (telegramId === ADMIN_TG_ID) return ctx.reply('Asosiy adminni qayta qo\'shib bo\'lmaydi.');
    const admin = await Admin.findOneAndUpdate(
      { telegramId },
      { $set: { active: true }, $setOnInsert: { telegramId, permissions: [] } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();
    adminRegistry.set(telegramId, admin);
    await logAdminAction(ctx, 'admin_added', String(telegramId));
    reset(ctx);
    return ctx.reply(`Admin qo\'shildi: ${telegramId}. Endi uning huquqlarini belgilang.`, adminKeyboard(ctx));
  }
  if (step === 'required_subscription_channel') {
    try {
      const channel = await checkFullAdmin(ctx, normalizeChannel(value));
      if (!data.settings.requiredChannels.some((item) => item.id === channel.id)) data.settings.requiredChannels.push(channel);
      await saveSettings();
      reset(ctx);
      ctx.session = { adminPanelActive: true };
      return ctx.reply(`${channel.title} majburiy obuna kanaliga qo'shildi.`, adminKeyboard(ctx));
    } catch (error) {
      return ctx.reply(error.message);
    }
  }
  return ctx.reply('Bu xabar uchun faol funksiya mavjud emas.', replyOptions());
});

bot.on('callback_query', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  reset(ctx);
});

bot.catch(async (error, ctx) => {
  console.error(`Update ${ctx.updateType} failed:`, error.response?.description || error.message);
  await safeAnswerCbQuery(ctx);
  try {
    if (ctx.from?.id) await ctx.telegram.sendMessage(ctx.from.id, '⚠️ Texnik xatolik yuz berdi. Iltimos, qaytadan urinib ko\'ring.', { protect_content: !isAdmin(ctx) });
  } catch (replyError) {
    console.error('Error notification failed:', replyError.response?.description || replyError.message);
  }
});

async function safeAnswerCbQuery(ctx) {
  if (!ctx.callbackQuery) return;
  try { await ctx.answerCbQuery(); } catch {}
}

async function startBot() {
  config.validateConfig();

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10000
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Express server ${port} portda ishlayapti.`);
  });

  await hydrateSettings();
  await bot.launch({
    allowedUpdates: ['message', 'channel_post', 'callback_query', 'chat_join_request', 'my_chat_member']
  });
  console.log('Movie bot ishga tushdi.');

  return server;
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error('Bot startup failed:', error);
    process.exitCode = 1;
  });
}

async function stopBot(signal) {
  bot.stop(signal);
  await telegramAccountManager.disconnect();
  await mongoose.disconnect();
}

process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));