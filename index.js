const http = require('http');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Remove stale Chromium lock files left by a previous container instance
['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach((f) => {
  try { fs.unlinkSync(`.wwebjs_auth/session/${f}`); } catch (_) {}
});

// Set this to your group's ID after running the bot once (it will be printed below).
// Example: '120363000000000000@g.us'
const TARGET_GROUP_ID = '120363424943457623@g.us';

// Optional: get a push notification on your phone when the bot disconnects.
// 1. Install the ntfy app (ntfy.sh) on your phone
// 2. Subscribe to a topic name of your choice (e.g. 'pingbot-alerts-yourname')
// 3. Set NTFY_TOPIC to that topic name as a Railway environment variable
const NTFY_TOPIC = process.env.NTFY_TOPIC || null;

async function notify(message) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: 'POST', body: message });
  } catch (_) {}
}

const RATE_LIMIT = 5;        // max stickers per window
const RATE_WINDOW_MS = 60_000; // 1 minute
const rateLimits = new Map(); // userId -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of rateLimits) {
    if (now >= entry.resetAt) rateLimits.delete(userId);
  }
}, RATE_WINDOW_MS);

function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateLimits.get(userId);

  if (!entry || now >= entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  if (entry.count >= RATE_LIMIT) return true;

  entry.count++;
  return false;
}

let qrDataUrl = null;
let botReady = false;

// Serve the QR code as a web page so it can be scanned from the Railway URL
const server = http.createServer(async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });

  if (botReady) {
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>Bot is connected and running!</h1></body></html>');
    return;
  }

  if (!qrDataUrl) {
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>Waiting for QR code...</h1><meta http-equiv="refresh" content="3"></body></html>');
    return;
  }

  res.end(`<html><body style="background:#111;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
    <div style="text-align:center">
      <h2 style="color:white;font-family:sans-serif">Scan with WhatsApp to connect the bot</h2>
      <img src="${qrDataUrl}" style="width:300px;height:300px;border-radius:12px">
      <meta http-equiv="refresh" content="30">
    </div>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QR server listening on port ${PORT}`));

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-zygote',
      // Reduce background CPU/network activity
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
      '--no-pings',
      // Cap disk and media caches to ~32 MB each
      '--disk-cache-size=33554432',
      '--media-cache-size=33554432',
      // Cap V8 heap to 512 MB so Chrome doesn't grow unbounded
      '--js-flags=--max-old-space-size=256',
      '--renderer-process-limit=1',
      // Misc hardening
      '--mute-audio',
      '--disable-notifications',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-domain-reliability',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
    ],
  },
});

client.on('qr', async (qr) => {
  qrDataUrl = await qrcode.toDataURL(qr);
  console.log('QR code ready. Open the app URL in your browser to scan it.');
});

client.on('ready', async () => {
  botReady = true;
  qrDataUrl = null;
  console.log('Bot is ready!');

  if (!TARGET_GROUP_ID) {
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (groups.length === 0) {
      console.log('No groups found. Create a group and add the bot number first.');
    } else {
      console.log('Groups found:');
      groups.forEach((g) => console.log(`  "${g.name}" → ${g.id._serialized}`));
      console.log('Copy your group ID into TARGET_GROUP_ID in index.js');
    }
  }
});

client.on('disconnected', async (reason) => {
  botReady = false;
  qrDataUrl = null;
  console.warn('Bot disconnected:', reason, '— reinitializing in 5s…');
  await notify(`PingBot disconnected: ${reason}. Reconnecting…`);

  setTimeout(async () => {
    try {
      await client.destroy();
    } catch (_) {}
    client.initialize();
  }, 5000);
});

client.on('auth_failure', async (msg) => {
  console.error('Authentication failed:', msg);
  await notify(`PingBot auth failure: ${msg}`);
});

// Errors that cross the puppeteer page boundary lose most of their detail and
// their class names are minified. Print every own property so the cause is visible.
function describeError(err) {
  if (!err) return String(err);
  const parts = [`${err.name || 'Error'}: ${err.message || '(no message)'}`];
  for (const key of Object.getOwnPropertyNames(err)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    let value;
    try { value = JSON.stringify(err[key]); } catch (_) { value = '(unserializable)'; }
    parts.push(`${key}=${value}`);
  }
  if (err.stack) parts.push(`\n${err.stack}`);
  return parts.join(' ');
}

// Safely reply without letting a send failure bubble up as an unhandled rejection.
async function safeReply(msg, content, options) {
  try {
    await msg.reply(content, null, options);
  } catch (err) {
    console.warn('Failed to reply:', err && err.message);
  }
}

client.on('message_create', async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.body.trim().toLowerCase() !== '!sticker') return;
    if (TARGET_GROUP_ID && msg.from !== TARGET_GROUP_ID && msg.to !== TARGET_GROUP_ID) return;
    if (isRateLimited(msg.author || msg.from)) {
      await safeReply(msg, 'You\'ve reached the limit of 5 stickers per minute. Try again shortly.');
      return;
    }

    let media = null;

    try {
      if (msg.hasMedia) {
        media = await msg.downloadMedia();
      } else if (msg.hasQuotedMsg) {
        const quoted = await msg.getQuotedMessage();
        if (quoted && quoted.hasMedia) {
          media = await quoted.downloadMedia();
        }
      }
    } catch (err) {
      // Errors thrown inside the WhatsApp Web page are minified, so err.message
      // is often just "r". Dump everything we can to make it diagnosable.
      console.warn('Media download failed:', describeError(err));
      await safeReply(msg, 'I couldn\'t download that image. Try sending it again as a new message.');
      return;
    }

    if (!media) {
      await safeReply(msg, 'Send an image with *!sticker* as the caption, or reply to an image with *!sticker*.');
      return;
    }

    await safeReply(msg, media, {
      sendMediaAsSticker: true,
      stickerName: 'PingBot',
      stickerAuthor: 'ChichenIT',
    });
  } catch (err) {
    console.error('Error handling message:', err && err.stack);
  }
});

// Last-resort guards. A rejected promise from puppeteer/whatsapp-web.js internals
// should never take the whole bot down — log it and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && (reason.stack || reason.message || reason));
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && (err.stack || err.message));
});

// Schedule a daily restart at 04:00 UTC to prevent Chromium memory buildup.
// Railway will automatically restart the container on exit.
function scheduleRestart() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(4, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  console.log(`Scheduled restart in ${Math.round(msUntil / 60000)} min (04:00 UTC)`);
  setTimeout(async () => {
    console.log('Performing scheduled daily restart to reclaim memory…');
    await notify('PingBot: scheduled daily restart to reclaim memory.');
    try { await client.destroy(); } catch (_) {}
    process.exit(1);
  }, msUntil);
}
scheduleRestart();

client.initialize();
