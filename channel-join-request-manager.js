'use strict';

/**
 * Registers channel join-request management on an existing Telegraf bot.
 *
 * The bot must be an administrator in each channel and have permission to
 * invite users. Secret channels are supported by passing their numeric chat ID
 * (for example: -1001234567890) to the commands below.
 *
 * Commands, usable by a channel administrator in a private chat:
 *   /join_auto <channel_id>       Approve every new request automatically.
 *   /join_ignore <channel_id>     Leave requests untouched.
 *   /join_accept_all <channel_id> Approve all currently pending requests.
 *   /join_status <channel_id>     Show the current mode.
 *
 * Usage from the main application:
 *   const { registerChannelJoinRequests } = require('./channel-join-request-manager');
 *   registerChannelJoinRequests(bot);
 */

const MODES = Object.freeze({
  AUTO: 'auto',
  IGNORE: 'ignore',
  MANUAL: 'manual'
});

function parseChannelId(ctx) {
  const text = String(ctx.message?.text || '').trim();
  const parts = text.split(/\s+/);
  return parts[1] || '';
}

function createChannelJoinRequestManager(bot, options = {}) {
  if (!bot || !bot.telegram) {
    throw new TypeError('A Telegraf bot instance is required.');
  }

  const modes = new Map();
  const commandPrefix = options.commandPrefix || 'join';

  async function assertChannelAdmin(ctx, channelId) {
    if (!channelId) throw new Error('Kanal ID sini yuboring. Maxfiy kanal uchun -100... ID ishlating.');
    if (!ctx.from?.id) throw new Error('Foydalanuvchi aniqlanmadi.');

    const chat = await bot.telegram.getChat(channelId);
    if (!['channel', 'supergroup'].includes(chat.type)) {
      throw new Error('Faqat kanal yoki supergroup qabul qilinadi.');
    }

    const userMember = await bot.telegram.getChatMember(chat.id, ctx.from.id);
    if (!['creator', 'administrator'].includes(userMember.status)) {
      throw new Error('Bu amal uchun kanal administratori bo\'lishingiz kerak.');
    }

    const botInfo = await bot.telegram.getMe();
    const botMember = await bot.telegram.getChatMember(chat.id, botInfo.id);
    if (!['creator', 'administrator'].includes(botMember.status)) {
      throw new Error('Bot kanalga administrator qilib qo\'shilmagan.');
    }
    if (botMember.status === 'administrator' && botMember.can_invite_users === false) {
      throw new Error('Botga kanal ichida userlarni taklif qilish huquqini bering.');
    }

    return chat;
  }

  async function setMode(ctx, mode) {
    const channelId = parseChannelId(ctx);
    const chat = await assertChannelAdmin(ctx, channelId);
    modes.set(String(chat.id), mode);
    return ctx.reply(`Kanal: ${chat.title || chat.id}\nRejim: ${mode}`);
  }

  async function approveAll(channelId) {
    const approved = [];
    const failed = [];
    let offset;

    while (true) {
      const payload = { chat_id: channelId, limit: 100 };
      if (offset) payload.offset = offset;
      const requests = await bot.telegram.callApi('getChatJoinRequests', payload);
      if (!requests.length) break;

      for (const request of requests) {
        try {
          await bot.telegram.approveChatJoinRequest(channelId, request.user.id);
          approved.push(request.user.id);
        } catch (error) {
          failed.push({ userId: request.user.id, message: error.message });
        }
      }

      if (requests.length < 100) break;
      offset = requests[requests.length - 1].user.id;
    }

    return { approved, failed };
  }

  async function acceptAll(ctx) {
    const channelId = parseChannelId(ctx);
    const chat = await assertChannelAdmin(ctx, channelId);
    const result = await approveAll(chat.id);
    return ctx.reply(
      `Qabul qilindi: ${result.approved.length}\n` +
      `Xatolik: ${result.failed.length}`
    );
  }

  async function showStatus(ctx) {
    const channelId = parseChannelId(ctx);
    const chat = await assertChannelAdmin(ctx, channelId);
    return ctx.reply(`Kanal: ${chat.title || chat.id}\nRejim: ${modes.get(String(chat.id)) || MODES.MANUAL}`);
  }

  async function commandHandler(ctx, action) {
    try {
      if (action === 'auto') return await setMode(ctx, MODES.AUTO);
      if (action === 'ignore') return await setMode(ctx, MODES.IGNORE);
      if (action === 'accept_all') return await acceptAll(ctx);
      return await showStatus(ctx);
    } catch (error) {
      return ctx.reply(`Join request sozlamasi xatosi: ${error.message}`);
    }
  }

  bot.command(`${commandPrefix}_auto`, (ctx) => commandHandler(ctx, 'auto'));
  bot.command(`${commandPrefix}_ignore`, (ctx) => commandHandler(ctx, 'ignore'));
  bot.command(`${commandPrefix}_accept_all`, (ctx) => commandHandler(ctx, 'accept_all'));
  bot.command(`${commandPrefix}_status`, (ctx) => commandHandler(ctx, 'status'));

  bot.on('chat_join_request', async (ctx) => {
    const request = ctx.chatJoinRequest;
    const channelId = String(request.chat.id);
    if (modes.get(channelId) !== MODES.AUTO) return;

    try {
      await bot.telegram.approveChatJoinRequest(request.chat.id, request.from.id);
    } catch (error) {
      console.error(`Join request approval failed for ${channelId}:`, error.message);
    }
  });

  return {
    modes: MODES,
    setMode: (channelId, mode) => {
      if (!Object.values(MODES).includes(mode)) throw new Error(`Unknown mode: ${mode}`);
      modes.set(String(channelId), mode);
    },
    getMode: (channelId) => modes.get(String(channelId)) || MODES.MANUAL,
    approveAll,
    clear: () => modes.clear()
  };
}

module.exports = {
  MODES,
  createChannelJoinRequestManager,
  registerChannelJoinRequests: createChannelJoinRequestManager
};
