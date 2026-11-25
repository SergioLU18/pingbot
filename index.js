import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import sharp from 'sharp';
import webpmux from 'node-webpmux';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Keep the session on the Railway volume (Railway sets RAILWAY_VOLUME_MOUNT_PATH)
// so it survives redeploys without touching the volume settings.
const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.wwebjs_auth';
const AUTH_DIR = process.env.AUTH_DIR || path.join(VOLUME_DIR, 'baileys');

// Only answer in this group.
const TARGET_GROUP_ID = '120363424943457623@g.us';

const STICKER_NAME = 'PingBot';
const STICKER_AUTHOR = 'ChichenIT';

const RATE_LIMIT = 5;          // max stickers per window
const RATE_WINDOW_MS = 60_000; // 1 minute

// Refuse to download anything bigger than this — the whole file is held in memory.
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

// Sound stickers (!soundsticker): longest clip we keep, and the biggest WebP we
// try to send (uploads around 1 MB have been reported to fail with HTTP 413).
const SOUND_MAX_SECONDS = 10;
const SOUND_MAX_WEBP_BYTES = 900 * 1024;

// Optional push notifications via ntfy.sh (set NTFY_TOPIC in Railway).
const NTFY_TOPIC = process.env.NTFY_TOPIC || null;

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// ---------------------------------------------------------------------------
// One-time cleanup of the old whatsapp-web.js Chromium profile on the volume
// ---------------------------------------------------------------------------

// The volume may be mounted at .wwebjs_auth (old data in ./session) or at
// .wwebjs_auth/session itself (old Chromium profile at its root). Either way, if
// we see the old profile, delete everything except the Baileys folder.
const OLD_PROFILE_MARKERS = ['session', 'Default', 'Local State'];
if (OLD_PROFILE_MARKERS.some((m) => fs.existsSync(path.join(VOLUME_DIR, m)))) {
  for (const entry of fs.readdirSync(VOLUME_DIR)) {
    if (entry === path.basename(AUTH_DIR)) continue;
    try {
      fs.rmSync(path.join(VOLUME_DIR, entry), { recursive: true, force: true });
    } catch (err) {
      console.warn(`Could not remove old ${entry}:`, err.message);
    }
  }
  console.log(`Removed old whatsapp-web.js Chromium data from ${VOLUME_DIR}`);
}
fs.rmSync('.wwebjs_cache', { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function notify(message) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: message,
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) {}
}

const rateLimits = new Map(); // userJid -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of rateLimits) {
    if (now >= entry.resetAt) rateLimits.delete(userId);
  }
}, RATE_WINDOW_MS).unref();

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

// ---------------------------------------------------------------------------
// Sticker conversion
// ---------------------------------------------------------------------------

// WhatsApp reads the pack name/author from a custom EXIF block inside the WebP.
async function addStickerMetadata(webp, extra = {}) {
  const json = {
    'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
    'sticker-pack-name': STICKER_NAME,
    'sticker-pack-publisher': STICKER_AUTHOR,
    emojis: [''],
    ...extra,
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);

  const img = new webpmux.Image();
  await img.load(webp);
  img.exif = exif;
  return img.save(null);
}

async function imageToWebp(buffer) {
  const toWebp = (quality) =>
    sharp(buffer, { animated: true })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality })
      .toBuffer();

  // WhatsApp rejects static stickers much over 100 KB.
  let out = await toWebp(80);
  if (out.length > 100 * 1024) out = await toWebp(50);
  return out;
}

// stillImage: the input is a single picture, repeated for `seconds` to make an
// animation (sound stickers need to be animated).
async function videoToWebp(buffer, { seconds = 5, fps = 10, quality = 50, stillImage = false } = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const input = path.join(os.tmpdir(), `${id}.in`);
  const output = path.join(os.tmpdir(), `${id}.webp`);
  try {
    fs.writeFileSync(input, buffer);
    await execFileAsync('ffmpeg', [
      '-y', ...(stillImage ? ['-loop', '1'] : []), '-i', input,
      '-t', String(seconds), '-an',
      '-vf', "scale='iw*min(512/iw,512/ih)':'ih*min(512/iw,512/ih)',format=rgba," +
             `pad=512:512:'(512-iw)/2':'(512-ih)/2':'#00000000',setsar=1,fps=${fps}`,
      '-vcodec', 'libwebp', '-loop', '0', '-quality', String(quality),
      output,
    ], { timeout: 30_000 });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(output, { force: true });
  }
}

async function makeSticker(buffer, kind) {
  const webp = kind === 'videoMessage' ? await videoToWebp(buffer) : await imageToWebp(buffer);
  return addStickerMetadata(webp);
}

// ---------------------------------------------------------------------------
// Sound stickers
// ---------------------------------------------------------------------------
//
// WhatsApp's new "sound stickers" are not in Baileys' proto yet. This follows the
// Baileys forks that support them (plogme, AunuBaileys); unofficial, may change:
//   - a normal Message.stickerMessage, carrying the sound as
//     StickerMessage.audioMessage (field 26, an AudioMessage), and
//   - the WebP's EXIF JSON has "sound-sha256": hex SHA-256 of the audio file,
//     which is how the receiving phone pairs the sticker with its sound.
// Phones may also wrap one in Message field 134 (a FutureProofMessage holding a
// Message) — we unwrap that on receive.

// StickerMessage objects we send -> their AudioMessage. Appended on encode, since
// Baileys' encoder doesn't know field 26.
const stickerAudio = new WeakMap();

const encodeSticker = proto.Message.StickerMessage.encode;
proto.Message.StickerMessage.encode = function (message, writer) {
  const w = encodeSticker.call(this, message, writer);
  const audio = message && stickerAudio.get(message);
  if (audio) proto.Message.AudioMessage.encode(audio, w.uint32((26 << 3) | 2).fork()).ldelim();
  return w;
};

// Minimal protobuf reader: top-level fields of a buffer, or null if it isn't one.
function readFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let v = 0;
    let shift = 0;
    let b;
    do {
      if (i >= buf.length) throw new Error('eof');
      b = buf[i++];
      v += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return v;
  };
  try {
    while (i < buf.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const type = tag & 7;
      if (type === 0) fields.push({ field, value: varint() });
      else if (type === 2) {
        const len = varint();
        if (i + len > buf.length) return null;
        fields.push({ field, bytes: buf.subarray(i, i + len) });
        i += len;
      } else if (type === 1) { fields.push({ field, bytes: buf.subarray(i, i + 8) }); i += 8; }
      else if (type === 5) { fields.push({ field, bytes: buf.subarray(i, i + 4) }); i += 4; }
      else return null;
    }
  } catch {
    return null;
  }
  return fields;
}

const getField = (fields, n) => fields?.find((f) => f.field === n)?.bytes;

// "5:len32 'audio/ogg; codecs=opus', 13:1, ..." — field numbers and sizes, plus short
// label-like strings (mimetypes). No URLs, keys or text.
function describeFields(fields) {
  return (fields || []).map((f) => {
    if (f.bytes === undefined) return `${f.field}:${f.value}`;
    const s = Buffer.from(f.bytes).toString('latin1');
    return /^[\w/;=. -]{1,40}$/.test(s) && /[a-z]/.test(s) && !/^[A-Za-z0-9+/=]{20,}$/.test(s)
      ? `${f.field}:'${s}'`
      : `${f.field}:len${f.bytes.length}`;
  }).join(', ');
}

// Set DEBUG_STICKERS=1 to log the structure of sound stickers the bot receives.
const DEBUG_STICKERS = process.env.DEBUG_STICKERS === '1';

// StickerMessage objects (from decode) that came with a sound.
const receivedSoundStickers = new WeakSet();

// Debug: log the EXIF JSON inside a received sound sticker's WebP.
async function logStickerExif(sock, msg, stickerMessage) {
  try {
    const webp = await downloadMediaMessage(
      { key: msg.key, message: { stickerMessage } }, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    const img = new webpmux.Image();
    await img.load(webp);
    const exif = img.exif ? Buffer.from(img.exif) : null;
    const start = exif ? exif.indexOf('{') : -1;
    console.log('[sound sticker] EXIF:', start >= 0 ? exif.subarray(start).toString('utf8') : '(none)');
  } catch (err) {
    console.warn('[sound sticker] EXIF read failed:', err.message);
  }
}

const decodeMessage = proto.Message.decode;
proto.Message.decode = function (reader, length) {
  const message = decodeMessage.call(this, reader, length);
  // Only top-level decodes get a raw buffer; nested ones get a protobuf Reader.
  if (!(reader instanceof Uint8Array)) return message;
  try {
    let top = readFields(reader);
    let target = message;
    // Disappearing-messages chats wrap everything in ephemeralMessage (40).message (1).
    const ephemeral = readFields(getField(readFields(getField(top, 40)), 1));
    if (ephemeral && message.ephemeralMessage?.message) {
      top = ephemeral;
      target = message.ephemeralMessage.message;
    }
    const wrapped = readFields(getField(readFields(getField(top, 134)), 1));
    const stickerBytes = getField(top, 26) || getField(wrapped, 26);
    if (!stickerBytes) return message;
    const sticker = readFields(stickerBytes);
    const audio = readFields(getField(sticker, 26));
    if (!audio && !wrapped) return message;

    // Let the rest of the bot see a wrapped sound sticker as a normal sticker.
    if (!target.stickerMessage) target.stickerMessage = proto.Message.StickerMessage.decode(stickerBytes);
    receivedSoundStickers.add(target.stickerMessage);

    if (DEBUG_STICKERS) {
      console.log('[sound sticker] received');
      console.log('  message fields:', top.map((f) => f.field).join(', '));
      if (wrapped) console.log('  wrapped in 134, inner message fields:', wrapped.map((f) => f.field).join(', '));
      console.log('  sticker:', describeFields(sticker));
      console.log('  audio:', describeFields(audio));
    }
  } catch (err) {
    console.warn('Sound sticker inspection failed:', err.message);
  }
  return message;
};

// 64 bars, 0–100, like the waveform WhatsApp shows for voice notes.
function waveformFromPcm(pcm, bars = 64) {
  const samples = Math.floor(pcm.length / 2);
  const block = Math.floor(samples / bars);
  if (block === 0) return Buffer.alloc(bars);
  const raw = [];
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < block; j++) sum += Math.abs(pcm.readInt16LE((i * block + j) * 2));
    raw.push(sum / block);
  }
  const max = Math.max(...raw);
  return Buffer.from(raw.map((v) => (max > 0 ? Math.min(100, Math.floor((v * 100) / max)) : 0)));
}

// Extracts the audio as mono Ogg Opus. Returns null if the file has no audio.
async function toOggOpus(buffer) {
  const id = crypto.randomBytes(6).toString('hex');
  const input = path.join(os.tmpdir(), `${id}.in`);
  const output = path.join(os.tmpdir(), `${id}.ogg`);
  try {
    fs.writeFileSync(input, buffer);
    try {
      // Reported as required: without -vbr / -frame_duration / -avoid_negative_ts
      // the sticker shows up but phones won't play its sound.
      await execFileAsync('ffmpeg', [
        '-v', 'error', '-y', '-i', input,
        '-vn', '-t', String(SOUND_MAX_SECONDS),
        '-ar', '16000', '-ac', '1',
        '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on',
        '-compression_level', '10', '-frame_duration', '20', '-application', 'voip',
        '-avoid_negative_ts', 'make_zero', '-map_metadata', '-1',
        '-f', 'ogg', output,
      ], { timeout: 30_000 });
    } catch (err) {
      if (/does not contain any stream|matches no streams|Output file.*does not contain/i.test(err.stderr || err.message)) {
        return null;
      }
      throw err;
    }
    const ogg = fs.readFileSync(output);
    // Decode back to 8 kHz PCM for the duration and the waveform.
    const { stdout: pcm } = await execFileAsync(
      'ffmpeg', ['-v', 'error', '-i', output, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
    );
    if (pcm.length === 0) return null;
    return {
      ogg,
      seconds: Math.max(1, Math.ceil(pcm.length / 2 / 8000)),
      waveform: waveformFromPcm(pcm),
    };
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(output, { force: true });
  }
}

// Always animated (a still image becomes a slow loop of itself). The WebP must stay
// small, so step quality and frame rate down until it fits. Returns null if it can't.
async function makeSoundStickerWebp(buffer, kind, sound) {
  const exif = { 'sound-sha256': crypto.createHash('sha256').update(sound.ogg).digest('hex') };
  const attempts = kind === 'videoMessage'
    ? [{ fps: 10, quality: 50 }, { fps: 8, quality: 35 }, { fps: 6, quality: 20 }]
    : [{ fps: 2, quality: 60, stillImage: true }, { fps: 1, quality: 40, stillImage: true }];
  for (const opts of attempts) {
    const webp = await videoToWebp(buffer, { seconds: Math.min(sound.seconds, SOUND_MAX_SECONDS), ...opts });
    if (webp.length <= SOUND_MAX_WEBP_BYTES) return addStickerMetadata(webp, exif);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

const MEDIA_KINDS = ['imageMessage', 'videoMessage', 'stickerMessage'];

function findMedia(content) {
  if (!content) return null;
  for (const kind of MEDIA_KINDS) {
    if (content[kind]) return { kind, media: content[kind] };
  }
  return null;
}

function getText(content) {
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ''
  );
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const chatId = msg.key.remoteJid;
  if (chatId !== TARGET_GROUP_ID) return;

  const content = normalizeMessageContent(msg.message);
  if (DEBUG_STICKERS && content?.stickerMessage && receivedSoundStickers.has(content.stickerMessage)) {
    await logStickerExif(sock, msg, content.stickerMessage);
  }
  const command = getText(content).trim().toLowerCase();
  if (command !== '!sticker' && command !== '!soundsticker') return;

  const reply = (payload) =>
    sock.sendMessage(chatId, payload, { quoted: msg }).catch((err) => {
      console.warn('Failed to reply:', err.message);
    });

  const sender = msg.key.participant || chatId;
  if (isRateLimited(sender)) {
    await reply({ text: `You've reached the limit of ${RATE_LIMIT} stickers per minute. Try again shortly.` });
    return;
  }

  if (command === '!soundsticker') {
    await handleSoundSticker(sock, msg, content, reply);
    return;
  }

  // 1. Media sent with "!sticker" as the caption.
  let source = null;
  const own = findMedia(content);
  if (own) {
    source = { ...own, message: msg };
  } else {
    // 2. "!sticker" sent as a reply to a media message. The quoted message carries
    //    the media keys, so it can be downloaded without fetching the original.
    const ctx = content.extendedTextMessage?.contextInfo;
    const quoted = normalizeMessageContent(ctx?.quotedMessage);
    const found = findMedia(quoted);
    if (ctx && found) {
      source = {
        ...found,
        message: {
          key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
          message: quoted,
        },
      };
    } else if (ctx?.quotedMessage) {
      await reply({ text: "That message doesn't have an image. Reply to an image with *!sticker*." });
      return;
    }
  }

  if (!source) {
    await reply({ text: 'Send an image with *!sticker* as the caption, or reply to an image with *!sticker*.' });
    return;
  }

  const size = Number(source.media.fileLength || 0);
  if (size > MAX_MEDIA_BYTES) {
    await reply({ text: 'That file is too big to turn into a sticker.' });
    return;
  }

  let buffer;
  try {
    buffer = await downloadMediaMessage(source.message, 'buffer', {}, {
      logger,
      // Re-requests the media from the sender's phone if WhatsApp's CDN expired it.
      reuploadRequest: sock.updateMediaMessage,
    });
  } catch (err) {
    console.warn('Media download failed:', err.message);
    await reply({ text: "I couldn't download that image. Try sending it again as a new message." });
    return;
  }

  let sticker;
  try {
    sticker = await makeSticker(buffer, source.kind);
  } catch (err) {
    console.warn('Sticker conversion failed:', err.message);
    await reply({ text: "I couldn't turn that into a sticker." });
    return;
  }

  await reply({ sticker });
}

// A downloadable { message, media } for a quoted message.
function quotedSource(chatId, ctx, quoted, kind) {
  return {
    kind,
    media: quoted[kind],
    message: {
      key: { remoteJid: chatId, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
      message: quoted,
    },
  };
}

async function downloadSource(sock, source) {
  if (Number(source.media.fileLength || 0) > MAX_MEDIA_BYTES) throw new Error('TOO_BIG');
  return downloadMediaMessage(source.message, 'buffer', {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage,
  });
}

// !soundsticker works with:
//   - a video with sound (with !soundsticker as the caption, or replied to), or
//   - an image / video with !soundsticker as the caption, sent as a reply to an
//     audio or voice note — the image becomes the sticker and the audio its sound.
async function handleSoundSticker(sock, msg, content, reply) {
  const chatId = msg.key.remoteJid;
  const ctx =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo;
  const quoted = normalizeMessageContent(ctx?.quotedMessage);
  const own = findMedia(content);

  let visual = null;
  let audio = null;
  if (own && quoted?.audioMessage) {
    visual = { ...own, message: msg };
    audio = quotedSource(chatId, ctx, quoted, 'audioMessage');
  } else if (own?.kind === 'videoMessage') {
    visual = audio = { ...own, message: msg };
  } else if (!own && quoted?.videoMessage) {
    visual = audio = quotedSource(chatId, ctx, quoted, 'videoMessage');
  }

  if (!visual) {
    await reply({
      text: 'Send or reply to a video with sound with *!soundsticker*, ' +
            'or reply to an audio/voice note with an image captioned *!soundsticker*.',
    });
    return;
  }

  let visualBuffer;
  let audioBuffer;
  try {
    visualBuffer = await downloadSource(sock, visual);
    audioBuffer = audio === visual ? visualBuffer : await downloadSource(sock, audio);
  } catch (err) {
    if (err.message === 'TOO_BIG') {
      await reply({ text: 'That file is too big to turn into a sticker.' });
    } else {
      console.warn('Media download failed:', err.message);
      await reply({ text: "I couldn't download that. Try sending it again as a new message." });
    }
    return;
  }

  let webp;
  let sound;
  try {
    // One ffmpeg at a time to keep peak memory low.
    sound = await toOggOpus(audioBuffer);
    if (sound) webp = await makeSoundStickerWebp(visualBuffer, visual.kind, sound);
  } catch (err) {
    console.warn('Sound sticker conversion failed:', err.message);
    await reply({ text: "I couldn't turn that into a sound sticker." });
    return;
  }
  visualBuffer = audioBuffer = null;

  if (!sound) {
    await reply({ text: "That video has no sound. Use *!sticker* for a normal sticker." });
    return;
  }
  if (!webp) {
    await reply({ text: `That video is too heavy for a sound sticker. Try a shorter clip (up to ${SOUND_MAX_SECONDS}s).` });
    return;
  }

  try {
    const uploadOpts = { upload: sock.waUploadToServer, logger };
    const [{ stickerMessage }, { audioMessage }] = await Promise.all([
      prepareWAMessageMedia({ sticker: webp, isAnimated: true }, uploadOpts),
      prepareWAMessageMedia({
        audio: sound.ogg,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: sound.seconds,
        waveform: sound.waveform,
      }, uploadOpts),
    ]);

    Object.assign(stickerMessage, {
      width: 512,
      height: 512,
      isAnimated: true,
      isLottie: false,
      stickerSentTs: Date.now(),
      contextInfo: {
        stanzaId: msg.key.id,
        participant: msg.key.participant,
        quotedMessage: msg.message,
        // Baileys can't see inside the raw payload to add the disappearing-messages
        // timer, so copy it from the message that triggered us.
        ...(ctx?.expiration ? { expiration: ctx.expiration } : {}),
      },
    });

    stickerAudio.set(stickerMessage, audioMessage);
    await sock.relayMessage(chatId, proto.Message.create({ stickerMessage }), {});
  } catch (err) {
    console.warn('Sound sticker send failed:', err.message);
    await reply({ text: "I couldn't send the sound sticker." });
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

let qrDataUrl = null;
let botReady = false;
// True while logged out and waiting for someone to press "Generate QR".
let idle = false;
let sock = null;
let reconnectDelay = 2000;

// Group metadata is fetched on every send to a group unless cached.
const groupCache = new Map();

async function start() {
  idle = false;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu('PingBot'),
    // Don't request the full chat history. The small initial sync is left on (the
    // default) because Baileys needs it for LID mappings; we never store it.
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) groupCache.delete(u.id);
  });
  sock.ev.on('group-participants.update', ({ id }) => groupCache.delete(id));

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrDataUrl = await qrcode.toDataURL(qr);
      console.log('QR code ready. Open the app URL in your browser to scan it.');
    }

    if (connection === 'open') {
      botReady = true;
      qrDataUrl = null;
      reconnectDelay = 2000;
      console.log('Bot is ready!');
      try {
        groupCache.set(TARGET_GROUP_ID, await sock.groupMetadata(TARGET_GROUP_ID));
      } catch (err) {
        console.warn('Could not fetch target group metadata:', err.message);
      }
      return;
    }

    if (connection !== 'close') return;

    botReady = false;
    qrDataUrl = null;
    const code = lastDisconnect?.error?.output?.statusCode;
    const registered = !!state.creds.registered;

    if (code === DisconnectReason.loggedOut) {
      console.warn('Logged out — clearing session and waiting for "Generate QR".');
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      idle = true;
      await notify('PingBot was logged out. Open the app URL and press "Generate QR".');
      return;
    }

    if (!registered && code === DisconnectReason.timedOut) {
      // Nobody scanned the QR in time. Stop generating new ones until asked.
      console.warn('QR not scanned in time — idle until "Generate QR" is pressed.');
      idle = true;
      return;
    }

    // Anything else (restartRequired after pairing, network blips, etc.): reconnect.
    const delay = code === DisconnectReason.restartRequired ? 0 : reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    console.warn(`Connection closed (code ${code}) — reconnecting in ${delay / 1000}s…`);
    if (code !== DisconnectReason.restartRequired) {
      await notify(`PingBot disconnected (code ${code}). Reconnecting…`);
    }
    setTimeout(() => start().catch((err) => console.error('Reconnect failed:', err)), delay);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error('Error handling message:', err && err.stack);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Web page: QR code / status / "Generate QR" button
// ---------------------------------------------------------------------------

const page = (body) =>
  `<html><body style="font-family:sans-serif;text-align:center;padding:50px">${body}</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/start') {
    if (idle) {
      console.log('Start requested from web page.');
      start().catch((err) => {
        console.error('Start failed:', err);
        idle = true;
      });
    }
    res.writeHead(303, { Location: '/' });
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });

  if (botReady) {
    res.end(page('<h1>Bot is connected and running!</h1>'));
  } else if (idle) {
    res.end(page(`<h1>Bot is logged out</h1>
      <p>Press the button when you are ready to scan.</p>
      <form method="POST" action="/start"><button style="font-size:20px;padding:12px 24px">Generate QR</button></form>`));
  } else if (qrDataUrl) {
    res.end(`<html><body style="background:#111;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h2 style="color:white;font-family:sans-serif">Scan with WhatsApp to connect the bot</h2>
        <img src="${qrDataUrl}" style="width:300px;height:300px;border-radius:12px">
        <meta http-equiv="refresh" content="20">
      </div>
    </body></html>`);
  } else {
    res.end(page('<h1>Connecting…</h1><meta http-equiv="refresh" content="3">'));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

// Last-resort guards: log and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && (err.stack || err.message));
});

// No saved session → don't generate QRs nobody is looking at; wait for the button.
if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
  start().catch((err) => console.error('Start failed:', err));
} else {
  idle = true;
  console.log('No saved WhatsApp session — open the app URL and press "Generate QR".');
}
