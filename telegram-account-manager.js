'use strict';

const crypto = require('node:crypto');
const { Api, TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

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

  async function runLogin(flow, updateQrButton) {
    const client = createClient('');
    flow.client = client;
    try {
      await client.connect();
      const account = await client.signInUserWithQrCode(
        { apiId: parsedApiId, apiHash },
        {
          abortSignal: flow.abortController.signal,
          qrCode: async ({ token, expires }) => {
            const loginUrl = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
            console.info(`Telegram QR generated for user ${flow.telegramId}; expires at ${new Date(Number(expires) * 1000).toISOString()}.`);
            try {
              await updateQrButton(loginUrl);
              console.info(`Telegram QR image sent for user ${flow.telegramId}.`);
            } catch (error) {
              console.error(`Telegram QR image delivery failed for user ${flow.telegramId}:`, error.response?.description || error.message);
              throw new Error(`QR tasvirini Telegramga yuborib bo'lmadi: ${error.response?.description || error.message}`);
            }
          },
          onError: async (error) => {
            console.error(`Telegram QR login error for ${flow.telegramId}:`, error.message);
            return true;
          }
        }
      );
      if (!account || account.bot) throw new Error('QR login oddiy Telegram foydalanuvchi akkaunti bilan yakunlanmadi.');
      if (flow.abortController.signal.aborted) throw new Error('Login bekor qilindi.');
      await saveSession(flow.telegramId, encryptSession(client.session.save()));
      clients.set(String(flow.telegramId), client);
      await sendMessage(flow.telegramId, '✅ Telegram akkauntingiz ulandi. Endi /mychats orqali eski so\'rovlarni ko\'rishingiz mumkin.');
    } catch (error) {
      await client.disconnect();
      if (!flow.abortController.signal.aborted) {
        console.error(`Telegram QR login failed for user ${flow.telegramId}:`, error.response?.description || error.message);
        await sendMessage(flow.telegramId, `Telegram QR orqali ulash amalga oshmadi: ${error.message}`);
      }
    } finally {
      loginFlows.delete(String(flow.telegramId));
    }
  }

  return {
    isLoginActive(telegramId) {
      return loginFlows.has(String(telegramId));
    },

    async beginLogin(telegramId, updateQrButton) {
      requireConfiguration();
      if (loginFlows.has(String(telegramId))) {
        throw new Error('Telegram QR login jarayoni allaqachon ochiq. Bekor qilish uchun /cancel yuboring.');
      }
      if (await loadSession(telegramId)) {
        throw new Error('Telegram akkauntingiz allaqachon ulangan. Qayta ulashdan oldin /telegram_logout yuboring.');
      }
      const flow = { telegramId, client: null, abortController: new AbortController() };
      loginFlows.set(String(telegramId), flow);
      void runLogin(flow, updateQrButton).catch((error) => {
        console.error(`Telegram login flow failed for ${telegramId}:`, error.message);
      });
    },

    cancelLogin(telegramId) {
      const flow = loginFlows.get(String(telegramId));
      if (!flow) return false;
      flow.abortController.abort();
      return true;
    },

    async logout(telegramId) {
      const key = String(telegramId);
      const flow = loginFlows.get(key);
      if (flow) {
        flow.abortController.abort();
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
