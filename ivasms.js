import axios from 'axios';
import cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'otp_data.json');
const RANGES_FILE = path.join(__dirname, 'ranges_cache.json');

// IVASMS credentials – CHANGE THESE
const LOGIN_URL = 'https://www.ivasms.com/login';
const SMS_LIST_URL = 'https://www.ivasms.com/portal/sms/received/getsms/number';
const SMS_DETAILS_URL = 'https://www.ivasms.com/portal/sms/received/getsms/number/sms';
const RETURN_ALL_URL = 'https://www.ivasms.com/portal/numbers/return/allnumber/bluck';
const RETURN_RANGE_URL = 'https://www.ivasms.com/portal/numbers/return/range';
const EMAIL = 'tawandamahachi07@gmail.com';      // <-- REPLACE
const PASSWORD = 'mahachi2007';          // <-- REPLACE

let client = null;
let csrfToken = null;
let seenSms = new Set();
let monitorInterval = null;
let currentRanges = [];  // cached ranges { range, numbers[] }

// Callbacks from index.js
let getMainSock = null;
let getChannelJid = null;
let getMonitoringFlag = null;

// Expose seen count for status command
global.seenOtpCount = 0;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE));
      seenSms = new Set(data.seenSms || []);
      global.seenOtpCount = seenSms.size;
      console.log(`📂 Loaded ${seenSms.size} seen SMS IDs`);
    }
    if (fs.existsSync(RANGES_FILE)) {
      const rangesData = JSON.parse(fs.readFileSync(RANGES_FILE));
      currentRanges = rangesData.ranges || [];
    }
  } catch(e) { console.error('Load data error:', e); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ seenSms: [...seenSms] }, null, 2));
    global.seenOtpCount = seenSms.size;
  } catch(e) { console.error('Save data error:', e); }
}

function saveRanges() {
  try {
    fs.writeFileSync(RANGES_FILE, JSON.stringify({ ranges: currentRanges, updated: Date.now() }, null, 2));
  } catch(e) { console.error('Save ranges error:', e); }
}

async function login() {
  const newClient = axios.create({ withCredentials: true, timeout: 30000 });
  try {
    // Get login page for CSRF
    const loginPage = await newClient.get(LOGIN_URL);
    const $ = cheerio.load(loginPage.data);
    const token = $('input[name="_token"]').val();
    if (!token) throw new Error('CSRF token not found');
    
    const form = new URLSearchParams();
    form.append('_token', token);
    form.append('email', EMAIL);
    form.append('password', PASSWORD);
    
    const loginRes = await newClient.post(LOGIN_URL, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    if (loginRes.status === 200 && (loginRes.data.includes('Dashboard') || loginRes.data.includes('dashboard'))) {
      console.log('✅ IVASMS login successful');
      // Get CSRF token from dashboard
      const dashboard = await newClient.get('https://www.ivasms.com/portal/sms/received');
      const $2 = cheerio.load(dashboard.data);
      const metaCsrf = $2('meta[name="csrf-token"]').attr('content');
      if (metaCsrf) csrfToken = metaCsrf;
      return newClient;
    } else {
      throw new Error('Login failed – check credentials');
    }
  } catch (err) {
    console.error('IVASMS login error:', err.message);
    return null;
  }
}

async function ensureClient() {
  if (!client) {
    client = await login();
  }
  // Check if session still works by hitting a simple endpoint
  if (client) {
    try {
      const test = await client.get('https://www.ivasms.com/portal/dashboard', { timeout: 10000 });
      if (test.status === 200 && test.data.includes('logout')) return client;
    } catch(e) {
      console.log('Session expired, re-logging...');
      client = await login();
    }
  }
  return client;
}

async function fetchNumbersAndRanges() {
  const cl = await ensureClient();
  if (!cl) return [];
  try {
    const url = 'https://www.ivasms.com/portal/numbers?draw=1&length=5000';
    const res = await cl.get(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    const data = res.data;
    const rangesMap = new Map();
    if (data.data && Array.isArray(data.data)) {
      for (const row of data.data) {
        const range = row.range;
        const number = row.Number;
        if (!range || !number) continue;
        if (!rangesMap.has(range)) rangesMap.set(range, []);
        const numbersSet = new Set(rangesMap.get(range));
        numbersSet.add(number);
        rangesMap.set(range, Array.from(numbersSet));
      }
    }
    const ranges = Array.from(rangesMap.entries()).map(([range, numbers]) => ({ range, numbers }));
    currentRanges = ranges;
    saveRanges();
    console.log(`📡 Fetched ${ranges.length} ranges, total numbers: ${ranges.reduce((acc, r) => acc + r.numbers.length, 0)}`);
    return ranges;
  } catch (err) {
    console.error('Error fetching numbers/ranges:', err.message);
    return currentRanges.length ? currentRanges : [];
  }
}

async function getNumberIdList(rangeValue) {
  const cl = await ensureClient();
  if (!cl) return [];
  try {
    const formData = new URLSearchParams();
    formData.append('_token', csrfToken || '');
    formData.append('start', new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10));
    formData.append('end', new Date().toISOString().slice(0,10));
    formData.append('range', rangeValue);
    formData.append('draw', '1');
    formData.append('length', '100');
    const res = await cl.post(SMS_LIST_URL, formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrfToken }
    });
    const $ = cheerio.load(res.data);
    const numbers = [];
    $('.card.card-body.border-bottom.bg-100.p-2.rounded-0').each((i, el) => {
      const numberDiv = $(el).find('.col-sm-4.border-bottom');
      if (numberDiv.length) {
        const number = numberDiv.text().trim();
        const onclick = numberDiv.attr('onclick') || '';
        const match = onclick.match(/,\s*'(\d+)'/);
        const idNumber = match ? match[1] : '';
        if (number) numbers.push({ number, idNumber });
      }
    });
    return numbers;
  } catch (err) {
    console.error(`Failed to get number IDs for range ${rangeValue}:`, err.message);
    return [];
  }
}

async function fetchSmsForNumber(number, range, idNumber) {
  const cl = await ensureClient();
  if (!cl || !csrfToken) return null;
  try {
    const form = new URLSearchParams();
    form.append('_token', csrfToken);
    form.append('Number', number);
    form.append('Range', range);
    form.append('id_number', idNumber);
    const res = await cl.post(SMS_DETAILS_URL, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrfToken }
    });
    return res.data;
  } catch (err) {
    console.error(`Failed fetch SMS for ${number}:`, err.message);
    return null;
  }
}

function extractOtpAndService(html, number, rangeValue) {
  const $ = cheerio.load(html);
  const smsCards = $('.card.card-body.border-bottom.bg-soft-dark.p-2.rounded-0');
  if (!smsCards.length) return null;
  let bestOtp = null;
  let service = 'Unknown';
  let smsText = '';
  for (let i = 0; i < smsCards.length; i++) {
    const card = smsCards[i];
    const text = $(card).text().trim();
    if (text) {
      smsText = text;
      // Match 4-6 digit codes
      const matches = text.match(/\b(\d{4,6})\b/g);
      if (matches) {
        // Prefer 6-digit codes, then 5, then 4
        bestOtp = matches.sort((a,b) => b.length - a.length)[0];
      }
      if (text.toLowerCase().includes('whatsapp')) service = 'WhatsApp';
      else if (text.toLowerCase().includes('facebook')) service = 'Facebook';
      else if (text.toLowerCase().includes('instagram')) service = 'Instagram';
      else if (text.toLowerCase().includes('google')) service = 'Google';
      else if (text.toLowerCase().includes('telegram')) service = 'Telegram';
      else if (text.toLowerCase().includes('otp') || text.toLowerCase().includes('verification')) service = 'OTP Service';
      break;
    }
  }
  if (!bestOtp) return null;
  return { otp: bestOtp, service, smsText };
}

async function processAllSms() {
  if (!getMonitoringFlag || !getMonitoringFlag()) {
    // console.log('⏸️ OTP monitoring off');
    return;
  }
  const ranges = await fetchNumbersAndRanges();
  if (!ranges.length) return;
  
  for (const { range, numbers } of ranges) {
    // Get number list with internal IDs
    const numberIds = await getNumberIdList(range);
    if (!numberIds.length) continue;
    
    for (const { number, idNumber } of numberIds) {
      const smsHtml = await fetchSmsForNumber(number, range, idNumber);
      if (!smsHtml) continue;
      const extracted = extractOtpAndService(smsHtml, number, range);
      if (!extracted) continue;
      const { otp, service, smsText } = extracted;
      const uniqueId = `${number}_${otp}_${Date.now()}`;
      if (seenSms.has(uniqueId)) continue;
      seenSms.add(uniqueId);
      saveData();
      
      // Format country from range (e.g., "KENYA 5544" -> "KENYA")
      const country = range.split(' ')[0] || 'Unknown';
      const phoneMasked = number.length > 6 ? number.slice(0, -4) + '****' : number;
      const formattedTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
      
      const message = 
`━━━━━━━━━━━━━━━━━━━━━
🔐 *${service} OTP Notification* 🔐
━━━━━━━━━━━━━━━━━━━━━
🌍 *Country*: ${country}
⚙️ *Service*: ${service}
📱 *Number*: ${phoneMasked}
🔑 *OTP Code*: \`${otp}\`
📜 *Message Content*:
\`\`\`
${smsText.length > 300 ? smsText.substring(0, 300) + '...' : smsText}
\`\`\`
🕒 *Received At*: ${formattedTime} (Asia/Dhaka)
━━━━━━━━━━━━━━━━━━━━━
🚀 *Status*: Awaiting Action
👨‍💻 *Powered by*: ALPHA-KING p
━━━━━━━━━━━━━━━━━━━━━`;
      
      const sock = getMainSock ? getMainSock() : null;
      const channelJid = getChannelJid ? getChannelJid() : null;
      if (sock && channelJid) {
        try {
          await sock.sendMessage(channelJid, { text: message });
          console.log(`📤 OTP ${otp} sent to channel ${channelJid}`);
        } catch (err) {
          console.error('Failed to send OTP to channel:', err.message);
        }
      } else {
        console.log('⚠️ No WhatsApp socket or channel JID – cannot send OTP');
      }
    }
  }
}

// ------------------- Public API for commands -------------------
export async function startSmsMonitor(getSock, getChannel, getActiveFlag) {
  getMainSock = getSock;
  getChannelJid = getChannel;
  getMonitoringFlag = getActiveFlag;
  loadData();
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(async () => {
    try {
      await processAllSms();
    } catch (err) {
      console.error('SMS monitor cycle error:', err);
    }
  }, 15000); // every 15 seconds
  console.log('🔄 IVASMS SMS monitor started');
}

export function stopSmsMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  console.log('⏹️ IVASMS SMS monitor stopped');
}

export async function getLiveRanges() {
  const ranges = await fetchNumbersAndRanges();
  return ranges.map(r => `${r.range} (${r.numbers.length} numbers)`);
}

export async function getAllNumbers() {
  const ranges = await fetchNumbersAndRanges();
  const all = [];
  for (const r of ranges) all.push(...r.numbers);
  return all;
}

export async function updateNumbers() {
  try {
    await fetchNumbersAndRanges();
    return true;
  } catch (err) {
    console.error('Update numbers error:', err);
    return false;
  }
}

export async function getFreshNumbers(limit = 10) {
  const all = await getAllNumbers();
  // Shuffle and return first `limit`
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
}

export async function returnAllNumbers() {
  const cl = await ensureClient();
  if (!cl) return false;
  try {
    const form = new URLSearchParams();
    if (csrfToken) form.append('_token', csrfToken);
    const res = await cl.post(RETURN_ALL_URL, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrfToken || '' }
    });
    if (res.status === 200) {
      // Clear local ranges cache
      currentRanges = [];
      saveRanges();
      return true;
    }
    return false;
  } catch (err) {
    console.error('Return all numbers error:', err);
    return false;
  }
}

export async function returnRange(rangeName) {
  const cl = await ensureClient();
  if (!cl) return false;
  try {
    const form = new URLSearchParams();
    if (csrfToken) form.append('_token', csrfToken);
    form.append('range', rangeName);
    const res = await cl.post(`${RETURN_RANGE_URL}/${encodeURIComponent(rangeName)}`, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-TOKEN': csrfToken || '' }
    });
    if (res.status === 200) {
      // Remove range from cache
      currentRanges = currentRanges.filter(r => r.range !== rangeName);
      saveRanges();
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Return range ${rangeName} error:`, err);
    return false;
  }
}

export async function syncNow() {
  try {
    await fetchNumbersAndRanges();
    return true;
  } catch (err) {
    console.error('Sync error:', err);
    return false;
  }
}