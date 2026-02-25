const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Set this to your group's ID after running the bot once (it will be printed below).
// Example: '120363000000000000@g.us'
const TARGET_GROUP_ID = '120363424943457623@g.us';

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox'] },
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('QR code generated. Scan it with WhatsApp on your phone.');
});

client.on('ready', async () => {
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
