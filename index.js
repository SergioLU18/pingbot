const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Set this to your group's ID after running the bot once (it will be printed below).
// Example: '120363000000000000@g.us'
const TARGET_GROUP_ID = '120363424943457623@g.us';

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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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

client.on('auth_failure', (msg) => {
  console.error('Authentication failed:', msg);
});

client.on('message_create', async (msg) => {
  if (msg.body.trim().toLowerCase() !== '!sticker') return;
  if (TARGET_GROUP_ID && msg.from !== TARGET_GROUP_ID && msg.to !== TARGET_GROUP_ID) return;

  let media = null;

  if (msg.hasMedia) {
    media = await msg.downloadMedia();
  } else if (msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage();
    if (quoted.hasMedia) {
      media = await quoted.downloadMedia();
    }
  }

  if (!media) {
    await msg.reply('Send an image with *!sticker* as the caption, or reply to an image with *!sticker*.');
    return;
  }

  await msg.reply(media, null, {
    sendMediaAsSticker: true,
    stickerName: 'PingBot',
    stickerAuthor: 'ChichenIT',
  });
});

client.initialize();
