'use strict';

const crypto = require('node:crypto');
const { Api, TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const INPUT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 5000;
const PAGE_SIZE = 100;

function createTelegramAccountManager({
  apiId,
  apiHash,
  encryptionKey,
  loadSession,
  saveSession,
  deleteSession,
  sendMessage
}) {
  const configured = [apiId, apiHash, encryptionKey].filter(Boolean).length;
  const parsedApiId = Number(apiId);
  const encryptionKeyIsValid = typeof encryptionKey === 'string' && /^[a-f\d]{64}$/i.test(encryptionKey);
  const clients = new Map();
  const loginFlows = new Map();

  function requireConfiguration() {
    if (configured !== 3 || !Number.isSafeInteger(parsedApiId) || parsedApiId <= 0 || !encryptionKeyIsValid) {
      throw new Error(
        'Bot egasi TELEGRAM_API_ID, TELEGRAM_API_HASH va 64 belgili TELEGRAM_SESSION_ENCRYPTION_KEY ni sozlashi kerak.'
      );
    }
  }

  function encryptSession(session) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(session, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
  }

  function decryptSession(value) {
    const [ivValue, tagValue, ciphertextValue] = String(value).split('.');
    if (!ivValue || !tagValue || !ciphertextValue) {
      throw new Error('Saqlangan Telegram sessiyasi yaroqsiz. Telegram akkauntini qayta ulang.');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), Buffer.from(ivValue, 'base64'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64')),
        decipher.final()
      ]).toString('utf8');
    } catch {
      throw new Error('Telegram sessiyasini ochib bo\'lmadi. Serverdagi shifrlash kaliti o\'zgargan bo\'lishi mumkin.');
    }
  }

  function createClient(session) {
    return new TelegramClient(new StringSession(session), parsedApiId, apiHash, {
      connectionRetries: 5
    });
  }

  async function connectSavedClient(telegramId) {
    requireConfiguration();
    const key = String(telegramId);
    const cached = clients.get(key);
    if (cached?.connected) return cached;
    if (cached) clients.delete(key);

    const record = await loadSession(telegramId);
    if (!record) return null;
    const client = createClient(decryptSession(record.encryptedSession));
    try {
      await client.connect();
      if (!(await client.checkAuthorization())) {
        throw new Error('Telegram sessiyasi muddati tugagan. Akkauntni qayta ulang.');
      }
      await client.getMe();
      clients.set(key, client);
      return client;
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  }

  function promptForInput(flow, message) {
    return new Promise((resolve, reject) => {
      if (flow.pendingInput) {
        reject(new Error('Telegram login kutilmagan holatga tushdi.'));
        return;
      }
      const timer = setTimeout(() => {
        flow.pendingInput = null;
        reject(new Error('Login muddati tugadi. Qaytadan /telegram_login yuboring.'));
      }, INPUT_TIMEOUT_MS);
      flow.pendingInput = {
        resolve: (value) => {
          clearTimeout(timer);
          flow.pendingInput = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          flow.pendingInput = null;
          reject(error);
        }
      };
      sendMessage(flow.telegramId, message).catch((error) => {
        flow.pendingInput?.reject(error);
      });
    });
  }

  async function runLogin(flow) {
    const client = createClient('');
    flow.client = client;
    try {
      await client.start({
        phoneNumber: () => promptForInput(flow, `Telegram telefon raqamingizni xalqaro formatda yuboring (masalan, +998...). Loginni bekor qilish uchun /cancel yuboring.`),
        phoneCode: (_isCodeViaApp, info) => promptForInput(
          flow,
          `Telegram tasdiqlash kodini yuboring (${info?.type || 'Telegram ilovasi'} orqali kelgan). Kodni hech kimga bermang. Bekor qilish: /cancel.`
        ),
        password: () => promptForInput(flow, 'Telegram 2 bosqichli himoya parolini yuboring. U saqlanmaydi. Bekor qilish: /cancel.'),
        emailAddress: () => promptForInput(flow, 'Telegram login email manzilingizni yuboring. Bekor qilish: /cancel.'),
        emailVerification: async () => ({
          type: 'code',
          code: await promptForInput(flow, 'Emailga kelgan Telegram tasdiqlash kodini yuboring. Bekor qilish: /cancel.')
        }),
        onError: (error) => console.error(`Telegram login error for ${flow.telegramId}:`, error.message)
      });
      const account = await client.getMe();
      if (account.bot) throw new Error('Bot akkaunt emas, oddiy Telegram foydalanuvchi akkauntini ulang.');
      await saveSession(flow.telegramId, encryptSession(client.session.save()));
      clients.set(String(flow.telegramId), client);
      await sendMessage(flow.telegramId, '✅ Telegram akkauntingiz xavfsiz shifrlangan sessiya bilan ulandi. Endi /mychats orqali eski so\'rovlarni ko\'rishingiz mumkin.');
    } catch (error) {
      await client.disconnect();
      const message = error.message === 'AUTH_RESTART'
        ? 'Login jarayoni bekor qilindi.'
        : `Telegram akkauntini ulab bo\'lmadi: ${error.message}`;
      await sendMessage(flow.telegramId, message);
    } finally {
      loginFlows.delete(String(flow.telegramId));
    }
  }

  return {
    isLoginActive(telegramId) {
      return loginFlows.has(String(telegramId));
    },

    async beginLogin(telegramId) {
      requireConfiguration();
      if (loginFlows.has(String(telegramId))) {
        throw new Error('Telegram login jarayoni allaqachon ochiq. Bekor qilish uchun /cancel yuboring.');
      }
      if (await loadSession(telegramId)) {
        throw new Error('Telegram akkauntingiz allaqachon ulangan. Qayta ulashdan oldin /telegram_logout yuboring.');
      }
      const flow = { telegramId, pendingInput: null, client: null };
      loginFlows.set(String(telegramId), flow);
      void runLogin(flow).catch((error) => {
        console.error(`Telegram login flow failed for ${telegramId}:`, error.message);
      });
    },

    async handleInput(ctx) {
      if (ctx.chat?.type !== 'private' || !ctx.from?.id) return false;
      const flow = loginFlows.get(String(ctx.from.id));
      if (!flow) return false;
      const value = String(ctx.message?.text || '').trim();
      if (value.toLowerCase() === '/cancel') {
        flow.pendingInput?.reject(new Error('AUTH_RESTART'));
        return ctx.deleteMessage().then(() => true, () => true);
      }
      if (!flow.pendingInput) return false;
      if (!value || value.length > 512) {
        await ctx.reply('Qiymat yaroqsiz. Qayta yuboring yoki /cancel bosing.');
        return true;
      }
      const pendingInput = flow.pendingInput;
      pendingInput.resolve(value);
      try {
        await ctx.deleteMessage();
      } catch (error) {
        console.warn(`Could not delete Telegram login input for ${ctx.from.id}:`, error.response?.description || error.message);
      }
      return true;
    },

    async logout(telegramId) {
      const key = String(telegramId);
      const flow = loginFlows.get(key);
      if (flow) {
        flow.pendingInput?.reject(new Error('AUTH_RESTART'));
        if (flow.client?.connected) await flow.client.disconnect();
        loginFlows.delete(key);
      }
      const client = clients.get(key);
      clients.delete(key);
      if (client?.connected) await client.disconnect();
      await deleteSession(telegramId);
    },

    async isLinked(telegramId) {
      return Boolean(await loadSession(telegramId));
    },

    isConfigured() {
      return configured === 3 && Number.isSafeInteger(parsedApiId) &&
        parsedApiId > 0 && encryptionKeyIsValid;
    },

    async getPendingRequests(telegramId, chat) {
      const client = await connectSavedClient(telegramId);
      if (!client) return null;
      let entity;
      if (chat.username) {
        entity = await client.getEntity(chat.username.replace(/^@/, ''));
      } else {
        const chatId = String(chat.chatId);
        const channelId = chatId.startsWith('-100') ? chatId.slice(4) : '';
        if (!channelId) throw new Error('MTProto akkaunti ushbu kanalni aniqlay olmadi.');
        const dialogs = await client.getDialogs({ limit: 5000 });
        entity = dialogs.map((dialog) => dialog.entity).find((item) =>
          item?.className === 'Channel' && String(item.id) === channelId
        );
        if (!entity) {
          throw new Error('Telegram akkauntingiz ushbu kanalga a’zo bo\'lishi kerak.');
        }
      }

      const peer = await client.getInputEntity(entity);
      let offsetDate = 0;
      let offsetUser = new Api.InputUserEmpty();
      const requests = [];
      while (requests.length < MAX_REQUESTS) {
        const result = await client.api.messages.getChatInviteImporters({
          peer,
          requested: true,
          offsetDate,
          offsetUser,
          limit: Math.min(PAGE_SIZE, MAX_REQUESTS - requests.length)
        });
        const usersById = new Map((result.users || []).map((user) => [String(user.id), user]));
        requests.push(...result.importers.map((request) => {
          const user = usersById.get(String(request.userId));
          return {
            userId: Number(request.userId),
            username: user?.username || '',
            firstName: user?.firstName || '',
            lastName: user?.lastName || '',
            requestedAt: new Date(Number(request.date) * 1000)
          };
        }));
        if (result.importers.length < PAGE_SIZE || requests.length >= MAX_REQUESTS) break;
        const lastRequest = result.importers[result.importers.length - 1];
        const lastUser = usersById.get(String(lastRequest.userId));
        if (!lastUser) throw new Error('Telegram ro\'yxat sahifasi uchun kerakli user ma’lumotini bermadi.');
        offsetDate = Number(lastRequest.date);
        offsetUser = await client.getInputEntity(lastUser);
      }
      return requests;
    },

    async disconnect() {
      for (const client of clients.values()) {
        if (client.connected) await client.disconnect();
      }
      clients.clear();
    }
  };
}

module.exports = { createTelegramAccountManager };
