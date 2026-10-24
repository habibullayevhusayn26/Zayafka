'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { verifyTelegramWebAppInitData } = require('./telegram-webapp-auth');

const botToken = '123456:example-token';

function makeInitData({
  authDate = Math.floor(Date.now() / 1000),
  user = { id: 12345 },
  signature = 'telegram-ed25519-signature'
} = {}) {
  const values = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'test-query',
    signature,
    user: JSON.stringify(user)
  });
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  values.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return values.toString();
}

test('accepts valid recent Telegram Mini App init data', () => {
  assert.equal(verifyTelegramWebAppInitData(makeInitData(), botToken), 12345);
});

test('rejects modified or expired Telegram Mini App init data', () => {
  const tampered = new URLSearchParams(makeInitData());
  tampered.set('user', JSON.stringify({ id: 54321 }));
  assert.equal(verifyTelegramWebAppInitData(tampered.toString(), botToken), null);
  assert.equal(
    verifyTelegramWebAppInitData(makeInitData({ authDate: Math.floor(Date.now() / 1000) - 301 }), botToken),
    null
  );
});
