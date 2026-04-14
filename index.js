import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import pino from 'pino';
import qrRouter from './qr.js';
import fs from 'fs';
import {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import pairRouter from './pair.js';
import { 
  startSmsMonitor, 
  stopSmsMonitor, 
  getLiveRanges, 
  getAllNumbers, 
  updateNumbers, 
  getFreshNumbers,
  returnAllNumbers,
  returnRange,
  syncNow
} from './ivasms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8000;

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/qr', qrRouter);
// ------------------- Routes -------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pair.html'));
});
app.use('/pair', pairRouter);
app.get('/qr', (req, res) => {
  // In a real implementation, you'd generate a QR code from an active socket
  res.json({ qr: 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=whatsapp://pair' });
});

// ------------------- Persistent State -------------------
const STATE_FILE = './bot_state.json';
let botState = {
  otpMonitoringActive: false,
  adminNumbers: [],      // will be loaded from file
  channelJid: null
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      botState = { ...botState, ...data };
      console.log('📂 Loaded bot state:', botState);
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

// Default admin (change to your number)
const DEFAULT_ADMIN = '263776404156'; // <-- REPLACE WITH YOUR NUMBER (without +)

if (!botState.adminNumbers.length) {
  botState.adminNumbers = [DEFAULT_ADMIN];
  saveState();
}

// ------------------- WhatsApp Main Bot -------------------
let mainSock = null;
let isReconnecting = false;
let botStartTime = Date.now();

const commands = {
  '.alphaotp': 'Start OTP monitoring (send OTPs to channel)',
  '.alphastop': 'Stop OTP monitoring',
  '.alpharange': 'Get live ranges from IVASMS',
  '.alphanum': 'Retrieve all available numbers',
  '.checkotp': 'Check all services (OTP status)',
  '.update': 'Update numbers/ranges from IVASMS',
  '.getnum': 'Get fresh numbers',
  '.pair': 'Add a new admin (usage: .pair +1234567890)',
  '.othermenu': 'Show other menu options',
  '.returnall': '⚠️ Return ALL numbers to IVASMS (admin only)',
  '.returnrange': 'Return a specific range (usage: .returnrange "KENYA 5544")',
  '.sync': 'Force sync numbers/ranges from IVASMS',
  '.setchannel': 'Set WhatsApp channel JID (usage: .setchannel 120363...@newsletter)',
  '.status': 'Show bot status',
  '.help': 'Show this help'
};

async function startMainBot() {
  if (isReconnecting) return;
  isReconnecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState('main_bot_session');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) console.log('📱 Scan QR for main bot (if first time)');
      if (connection === 'open') {
        console.log('✅ Main WhatsApp Bot connected');
        mainSock = sock;
        isReconnecting = false;
        // Send startup message to all admins
        for (const admin of botState.adminNumbers) {
          const jid = jidNormalizedUser(admin + '@s.whatsapp.net');
          await sock.sendMessage(jid, {
            text: `🔐 *AlphaOtp Bot Connected* ✅\n> Session admin code: 263JdgieS~AlphaOtp\n\n*Available commands:*\n${Object.entries(commands).map(([c, d]) => `${c} - ${d}`).join('\n')}\n\n> WITH ALPHA WE GO BEYOND LIMITS`
          }).catch(() => {});
        }
        // If OTP monitoring was active before restart, restart it
        if (botState.otpMonitoringActive && botState.channelJid) {
          startSmsMonitor(() => mainSock, () => botState.channelJid, () => botState.otpMonitoringActive);
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          console.log('🔄 Main bot disconnected, reconnecting in 5s...');
          setTimeout(startMainBot, 5000);
        } else {
          console.log('❌ Main bot logged out – delete main_bot_session folder and re-pair');
        }
        isReconnecting = false;
      }
    });

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      const sender = msg.key.participant || from;
      const senderNumber = sender.split('@')[0];
      
      // Only respond to admins
      if (!botState.adminNumbers.includes(senderNumber)) return;
      
      let text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption ||
                 '';
      if (!text) return;
      const cmd = text.trim().toLowerCase();
      const args = text.trim().split(/\s+/).slice(1);
      
      try {
        if (cmd === '.alphaotp') {
          if (!botState.channelJid) {
            await sock.sendMessage(from, { text: '❌ No WhatsApp channel set. Use .setchannel <JID>' });
            return;
          }
          if (!botState.otpMonitoringActive) {
            botState.otpMonitoringActive = true;
            saveState();
            startSmsMonitor(() => mainSock, () => botState.channelJid, () => botState.otpMonitoringActive);
            await sock.sendMessage(from, { text: '✅ OTP monitoring *STARTED*. New OTPs will be sent to the WhatsApp channel.' });
          } else {
            await sock.sendMessage(from, { text: 'ℹ️ OTP monitoring is already active.' });
          }
        }
        else if (cmd === '.alphastop') {
          if (botState.otpMonitoringActive) {
            botState.otpMonitoringActive = false;
            saveState();
            stopSmsMonitor();
            await sock.sendMessage(from, { text: '⛔ OTP monitoring *STOPPED*.' });
          } else {
            await sock.sendMessage(from, { text: 'ℹ️ OTP monitoring is not active.' });
          }
        }
        else if (cmd === '.alpharange') {
          await sock.sendMessage(from, { text: '📡 Fetching live ranges...' });
          const ranges = await getLiveRanges();
          await sock.sendMessage(from, { text: `📋 Live ranges:\n${ranges.join('\n') || 'None'}` });
        }
        else if (cmd === '.alphanum') {
          await sock.sendMessage(from, { text: '🔢 Retrieving all numbers...' });
          const nums = await getAllNumbers();
          const msgText = `📱 Total numbers: ${nums.length}\nFirst 20: ${nums.slice(0, 20).join(', ')}${nums.length > 20 ? '...' : ''}`;
          await sock.sendMessage(from, { text: msgText });
        }
        else if (cmd === '.checkotp') {
          const status = botState.otpMonitoringActive ? 'ACTIVE' : 'INACTIVE';
          await sock.sendMessage(from, { text: `🔍 OTP Service Status\nMonitoring: ${status}\nChannel JID: ${botState.channelJid || 'Not set'}\nSeen OTPs count: ${global.seenOtpCount || 0}` });
        }
        else if (cmd === '.update') {
          await sock.sendMessage(from, { text: '🔄 Updating numbers/ranges from IVASMS...' });
          const success = await updateNumbers();
          await sock.sendMessage(from, { text: success ? '✅ Update completed.' : '❌ Update failed. Check logs.' });
        }
        else if (cmd === '.getnum') {
          await sock.sendMessage(from, { text: '🎲 Fetching fresh numbers...' });
          const fresh = await getFreshNumbers();
          await sock.sendMessage(from, { text: `✨ Fresh numbers (max 10): ${fresh.join(', ') || 'None available'}` });
        }
        else if (cmd === '.pair') {
          if (args.length < 1) {
            await sock.sendMessage(from, { text: 'Usage: .pair +1234567890' });
            return;
          }
          let newAdmin = args[0].replace(/[^0-9]/g, '');
          if (newAdmin.length < 10) {
            await sock.sendMessage(from, { text: '❌ Invalid number.' });
            return;
          }
          if (!botState.adminNumbers.includes(newAdmin)) {
            botState.adminNumbers.push(newAdmin);
            saveState();
            await sock.sendMessage(from, { text: `✅ Added new admin: ${newAdmin}` });
          } else {
            await sock.sendMessage(from, { text: 'ℹ️ Already an admin.' });
          }
        }
        else if (cmd === '.returnall') {
          await sock.sendMessage(from, { text: '⚠️ Returning ALL numbers to IVASMS. This may take a moment...' });
          const result = await returnAllNumbers();
          await sock.sendMessage(from, { text: result ? '✅ All numbers returned successfully.' : '❌ Return failed. Check logs.' });
        }
        else if (cmd === '.returnrange') {
          if (args.length < 1) {
            await sock.sendMessage(from, { text: 'Usage: .returnrange "KENYA 5544"' });
            return;
          }
          const rangeName = args.join(' ');
          await sock.sendMessage(from, { text: `⚠️ Returning range "${rangeName}"...` });
          const result = await returnRange(rangeName);
          await sock.sendMessage(from, { text: result ? `✅ Range "${rangeName}" returned.` : `❌ Failed to return range "${rangeName}".` });
        }
        else if (cmd === '.sync') {
          await sock.sendMessage(from, { text: '🔄 Forcing full sync from IVASMS...' });
          const success = await syncNow();
          await sock.sendMessage(from, { text: success ? '✅ Sync completed.' : '❌ Sync failed.' });
        }
        else if (cmd === '.setchannel') {
          if (args.length < 1) {
            await sock.sendMessage(from, { text: 'Usage: .setchannel 120363123456789@newsletter' });
            return;
          }
          botState.channelJid = args[0];
          saveState();
          await sock.sendMessage(from, { text: `✅ WhatsApp channel JID set to: ${botState.channelJid}` });
          if (botState.otpMonitoringActive) {
            // restart monitor with new channel
            stopSmsMonitor();
            startSmsMonitor(() => mainSock, () => botState.channelJid, () => botState.otpMonitoringActive);
          }
        }
        else if (cmd === '.status') {
          const uptimeSec = Math.floor((Date.now() - botStartTime) / 1000);
          const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
          await sock.sendMessage(from, { text: `📊 *Bot Status*\nMonitoring: ${botState.otpMonitoringActive ? 'ON' : 'OFF'}\nChannel JID: ${botState.channelJid || 'Not set'}\nAdmins: ${botState.adminNumbers.join(', ')}\nUptime: ${uptimeStr}` });
        }
        else if (cmd === '.help') {
          let help = '🤖 *AlphaOtp Bot Commands*\n\n';
          for (const [c, d] of Object.entries(commands)) {
            help += `▪️ ${c} – ${d}\n`;
          }
          help += '\n> WITH ALPHA WE GO BEYOND LIMITS';
          await sock.sendMessage(from, { text: help });
        }
        else if (cmd === '.othermenu') {
          let menu = '📋 *Other Commands*\n\n';
          menu += '.help - Show this menu\n';
          menu += '.status - Show bot status\n';
          menu += '.ping - Check bot responsiveness\n';
          menu += '.uptime - Bot uptime\n';
          await sock.sendMessage(from, { text: menu });
        }
        else if (cmd === '.ping') {
          await sock.sendMessage(from, { text: '🏓 Pong!' });
        }
        else if (cmd === '.uptime') {
          const uptimeSec = Math.floor((Date.now() - botStartTime) / 1000);
          await sock.sendMessage(from, { text: `⏱️ Uptime: ${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s` });
        }
      } catch (err) {
        console.error('Command error:', err);
        await sock.sendMessage(from, { text: `❌ Error executing command: ${err.message}` });
      }
    });
  } catch (err) {
    console.error('Main bot start error:', err);
    isReconnecting = false;
    setTimeout(startMainBot, 10000);
  }
}

// ------------------- Start Everything -------------------
loadState();
startMainBot();
app.listen(PORT, () => {
  console.log(`🌐 AlphaOtpServices web running on http://localhost:${PORT}`);
  console.log(`📱 Admin numbers: ${botState.adminNumbers.join(', ')}`);
  console.log(`🔐 Security key for pairing: Alpha263`);
});