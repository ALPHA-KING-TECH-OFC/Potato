import express from 'express';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const router = express.Router();
const SESSION_DIR = './qr_sessions';

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// Store active QR sessions to avoid multiple simultaneous connections per user
const activeSessions = new Map();

router.get('/', async (req, res) => {
  let sessionId = req.query.session || 'default';
  
  // If there's already a session for this ID, close it to start fresh
  if (activeSessions.has(sessionId)) {
    const oldSock = activeSessions.get(sessionId);
    if (oldSock && oldSock.end) oldSock.end();
    activeSessions.delete(sessionId);
  }

  let qrGenerated = false;
  let timeoutId;

  try {
    const sessionPath = path.join(SESSION_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'fatal' }),
      browser: Browsers.macOS('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      defaultQueryTimeoutMs: 30000,
      connectTimeoutMs: 30000
    });

    activeSessions.set(sessionId, sock);

    // Handle QR event
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr && !qrGenerated) {
        qrGenerated = true;
        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(qr);
        // Send response only once
        if (!res.headersSent) {
          res.json({ qr: qrDataUrl, instructions: ['Scan this QR with WhatsApp > Linked Devices'] });
        }
        // Clean up after 30 seconds if not connected
        timeoutId = setTimeout(() => {
          if (activeSessions.has(sessionId)) {
            sock.end();
            activeSessions.delete(sessionId);
            // Remove session folder after timeout
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        }, 30000);
      }

      if (connection === 'open') {
        // Successfully connected via QR
        console.log(`✅ QR session ${sessionId} connected`);
        if (timeoutId) clearTimeout(timeoutId);
        // Optionally send a success message, but the response is already sent
        // Clean up after a delay
        setTimeout(() => {
          if (activeSessions.has(sessionId)) {
            sock.end();
            activeSessions.delete(sessionId);
          }
        }, 5000);
      }

      if (connection === 'close') {
        console.log(`❌ QR session ${sessionId} closed`);
        if (activeSessions.has(sessionId)) activeSessions.delete(sessionId);
        if (timeoutId) clearTimeout(timeoutId);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // If no QR after 20 seconds, send error
    setTimeout(() => {
      if (!qrGenerated && !res.headersSent) {
        res.status(504).json({ qr: null, error: 'Timeout waiting for QR code' });
        sock.end();
        activeSessions.delete(sessionId);
      }
    }, 20000);

  } catch (err) {
    console.error('QR generation error:', err);
    if (!res.headersSent) {
      res.status(500).json({ qr: null, error: 'Internal server error' });
    }
    if (activeSessions.has(sessionId)) {
      activeSessions.get(sessionId).end();
      activeSessions.delete(sessionId);
    }
  }
});

export default router;