'use strict';

const crypto = require('node:crypto');
const { Api, TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const MAX_REQUESTS = 5000;
const PAGE_SIZE = 100;

async function fetchAllPendingRequestPages({
  fetchPage,
  getInputUser,
  emptyOffsetUser,
  maxRequests = MAX_REQUESTS,
  pageSize = PAGE_SIZE
}) {
  let offsetDate = 0;
  let offsetUser = emptyOffsetUser;
  const seenCursors = new Set();
  const requests = [];
  const seenUserIds = new Set();

  while (requests.length < maxRequests) {
    const result = await fetchPage({
      offsetDate,
      offsetUser,
      limit: Math.min(pageSize, maxRequests - requests.length)
    });
    if (!result.importers.length) break;

    const usersById = new Map((result.users || []).map((user) => [String(user.id), user]));
    for (const request of result.importers) {
      const userId = String(request.userId);
      if (seenUserIds.has(userId)) continue;
      seenUserIds.add(userId);
      const user = usersById.get(userId);
      requests.push({
        userId: Number(userId),
        username: user?.username || '',
        firstName: user?.firstName || '',
        lastName: user?.lastName || '',
        requestedAt: new Date(Number(request.date) * 1000)
      });
    }
    if (requests.length >= maxRequests) break;

    const lastRequest = result.importers[result.importers.length - 1];
    const lastUser = usersById.get(String(lastRequest.userId));
    if (!lastUser) throw new Error('Telegram ro\'yxat sahifasi uchun kerakli user ma’lumotini bermadi.');
    const cursor = `${Number(lastRequest.date)}:${String(lastRequest.userId)}`;
    if (seenCursors.has(cursor)) {
      throw new Error('Telegram so\'rovlar sahifalashi oldinga siljimadi; sync xavfsiz to\'xtatildi.');
    }
    seenCursors.add(cursor);
    offsetDate = Number(lastRequest.date);
    offsetUser = await getInputUser(lastUser);
  }
  return requests;
}

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

  function requestLoginPassword(flow, promptPassword) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        flow.passwordResolver = null;
        flow.abortController.signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, new Error('Login bekor qilindi.'));
      const timeout = setTimeout(
        () => finish(reject, new Error('2FA parol kiritish vaqti tugadi. QR loginni qaytadan boshlang.')),
        5 * 60 * 1000
      );

      flow.passwordResolver = (password) => finish(resolve, password);
      flow.abortController.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promptPassword()).catch((error) => finish(reject, error));
    });
  }

  async function runLogin(flow, updateQrButton, promptPassword) {
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
          password: async (hint) => requestLoginPassword(flow, () => promptPassword(hint)),
          onError: async (error) => {
            if (['PASSWORD_HASH_INVALID', 'PASSWORD_MISSING', 'PASSWORD_EMPTY'].includes(error.errorMessage)) {
              await sendMessage(flow.telegramId, '2FA paroli noto‘g‘ri. Mini App orqali qaytadan kiriting.');
              return false;
            }
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

    async beginLogin(telegramId, updateQrButton, promptPassword) {
      requireConfiguration();
      if (typeof promptPassword !== 'function') {
        throw new Error('2FA parol Mini App so‘rovi sozlanmagan.');
      }
      if (loginFlows.has(String(telegramId))) {
        throw new Error('Telegram QR login jarayoni allaqachon ochiq. Bekor qilish uchun /cancel yuboring.');
      }
      if (await loadSession(telegramId)) {
        throw new Error('Telegram akkauntingiz allaqachon ulangan. Qayta ulashdan oldin /telegram_logout yuboring.');
      }
      const flow = { telegramId, client: null, abortController: new AbortController() };
      loginFlows.set(String(telegramId), flow);
      void runLogin(flow, updateQrButton, promptPassword).catch((error) => {
        console.error(`Telegram login flow failed for ${telegramId}:`, error.message);
      });
    },

    submitLoginPassword(telegramId, password) {
      const flow = loginFlows.get(String(telegramId));
      if (!flow?.passwordResolver || typeof password !== 'string' || !password.length || password.length > 128) {
        return false;
      }
      flow.passwordResolver(password);
      return true;
    },

    cancelLogin(telegramId) {
      const flow = loginFlows.get(String(telegramId));
      if (!flow) return false;
      flow.abortController.abort();
      flow.passwordResolver?.('');
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
      let peer;
      if (chat.username) {
        entity = await client.getEntity(chat.username.replace(/^@/, ''));
        peer = await client.getInputEntity(entity);
      } else if (chat.type === 'group') {
        const groupId = Math.abs(Number(chat.chatId));
        if (!Number.isSafeInteger(groupId) || groupId <= 0) {
          throw new Error('MTProto akkaunti guruh ID sini aniqlay olmadi.');
        }
        peer = new Api.InputPeerChat({ chatId: groupId });
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
        peer = await client.getInputEntity(entity);
      }

      return fetchAllPendingRequestPages({
        emptyOffsetUser: new Api.InputUserEmpty(),
        getInputUser: (user) => client.getInputEntity(user),
        fetchPage: ({ offsetDate, offsetUser, limit }) => client.api.messages.getChatInviteImporters({
          peer,
          requested: true,
          offsetDate,
          offsetUser,
          limit
        })
      });
    },

    async disconnect() {
      for (const client of clients.values()) {
        if (client.connected) await client.disconnect();
      }
      clients.clear();
    }
  };
}

module.exports = { createTelegramAccountManager, fetchAllPendingRequestPages };
