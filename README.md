# ZayafkaBot

Telegram bot for managing channel and group join requests. Every user can connect their own Telegram account to import pending requests received before the bot was added.

## Setup

1. Copy `.env.example` to `.env` and set the Bot API token, MongoDB URI, bot username, and owner details.
2. Create a Telegram API application at <https://my.telegram.org> and set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `.env`.
3. Generate a random 32-byte encryption key, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, and set it as `TELEGRAM_SESSION_ENCRYPTION_KEY`.
4. Run `npm start`.

Each user sends `/telegram_login` to the bot, confirms, then scans the QR image using Telegram's **Settings → Devices → Link Desktop Device** flow. No login code or password is sent to the bot. The authorized session is encrypted in MongoDB. Users can remove that session with `/telegram_logout`; `/cancel` stops an active login.

Keep the encryption key private and backed up. If it is lost or changed, stored sessions cannot be decrypted and each user must sign in again. The Telegram account connected by a user must be an administrator of the channel whose requests they want to import. The bot must also be a channel administrator with the invite-users permission to approve requests. Without the MTProto settings, the bot continues to handle new requests received after it is linked, but cannot discover older requests.

In `/mychats`, choose a linked channel to view pending requests. Individual requests can be approved from the list, or use the bulk-approve button.
