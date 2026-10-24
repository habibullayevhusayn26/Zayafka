'use strict';

const crypto = require('node:crypto');

function verifyTelegramWebAppInitData(initData, botToken) {
  if (typeof initData !== 'string' || initData.length > 4096 || typeof botToken !== 'string' || !botToken) {
    return null;
  }
  const params = new URLSearchParams(initData);
  const providedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userValue = params.get('user');
  const now = Date.now() / 1000;
  if (!providedHash || !/^[a-f\d]{64}$/i.test(providedHash) ||
      !Number.isInteger(authDate) || now - authDate > 300 ||
      authDate > now + 30 || !userValue) {
    return null;
  }

  let user;
  try {
    user = JSON.parse(userValue);
  } catch {
    return null;
  }
  const telegramId = Number(user.id);
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return null;

  params.delete('hash');
  params.delete('signature');
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(providedHash, 'hex');
  if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) return null;
  return telegramId;
}

module.exports = { verifyTelegramWebAppInitData };
