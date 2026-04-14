import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import path from 'path';

const router = express.Router();
const JAMES_TECH_DIR = './jamestech';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(JAMES_TECH_DIR);

function removeFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
  } catch(e) {}
}

router.get('/', async (req, res) => {
  let num = req.query.number;
  if (!num) return res.status(400).send({ code: 'Number required' });
  num = num.replace(/[^0-9]/g, '');
  const phone = pn('+' + num);
  if (!phone.isValid()) {
    return res.status(400).send({ code: 'Invalid phone number' });
  }
  num = phone.getNumber('e164').replace('+', '');
  const sessionDir = path.join(JAMES_TECH_DIR, `session_${num}`);
  ensureDir(sessionDir);
  // Remove old session to force fresh pairing
  await removeFile(sessionDir);
  ensureDir(sessionDir);

  async function initiateSession() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    try {
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.windows('Chrome'),
        markOnlineOnConnect: false,
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          console.log(`✅ Paired successfully: ${num}`);
          try {
            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
            // Send the new welcome caption with image
            await sock.sendMessage(userJid, {
              image: { url: 'https://files.catbox.moe/m4vltm.jpg' }, // You can change this URL
              caption: `🔥✅𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗧𝗼 𝗔𝗹𝗽𝗵𝗮 𝗦𝗲𝗿𝘃𝗲𝗿𝘀✅🔥\n> 𝗬𝗼𝘂 𝗮𝗿𝗲 𝗻𝗼𝘄 𝗼𝗻𝗲 𝗼𝗳 𝗨𝘀\n> 𝗧𝘆𝗽𝗲 .𝗺𝗲𝗻𝘂\n\n#stay safe\n#stayhealth\n#alphaotpservices`
            });
            console.log(`✅ Welcome message sent to ${num}`);
          } catch (err) {
            console.error('Error sending welcome message:', err);
          }
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === 401) console.log(`Logged out for ${num}`);
          else initiateSession();
        }
      });
      if (!state.creds.registered) {
        await delay(3000);
        try {
          let code = await sock.requestPairingCode(num);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          if (!res.headersSent) res.send({ code });
        } catch(err) {
          console.error(err);
          if (!res.headersSent) res.status(503).send({ code: 'Service Unavailable' });
        }
      }
    } catch(err) {
      console.error(err);
      if (!res.headersSent) res.status(503).send({ code: 'Service Unavailable' });
    }
  }
  await initiateSession();
});

export default router;