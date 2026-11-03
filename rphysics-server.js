#!/usr/bin/env node
/* ============================================================================
   rphysics-server.js — сервер для Rphysics: статика + WebSocket + комнаты + моды
   Без npm-зависимостей. Запуск:  node rphysics-server.js
   Потом открыть:  http://localhost:8080/rphysics/index.html
   В игре: меню карт → «Мультиплеер» → адрес пустой (= этот сайт) → Создать комнату.

   Порт: PORT=8080 (или переменная окружения PORT — удобно для хостингов).
   Что умеет:
     • отдаёт index.html / rmodder.html / modelmaker.html и любые файлы рядом
     • комнаты: создать / список / вход по паролю / лимит игроков
     • пересылка игровых сообщений (позиции, физика, чат) между участниками
     • хост — первый вошедший; при выходе хоста он назначается автоматически
     • раздача модов: хост жмёт «📤 Поделиться модами» → остальные получают их
       (код модов НЕ пересылается — только предметы, мобы, карты; правило безопасности)
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8080);
const ROOT = __dirname;
const MAX_PLAYERS = 12;
const MAX_PAYLOAD = 4 * 1024 * 1024;      // 4 МБ на сообщение
const TICK_LOG = 30000;

/* ----------------------------- WebSocket ---------------------------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsAccept = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

function wsFrame(str) {
  const data = Buffer.from(str, 'utf8');
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.from([0x81, len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, data]);
}
function wsPong(payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x8A, len]);
  else { head = Buffer.alloc(4); head[0] = 0x8A; head[1] = 126; head.writeUInt16BE(len, 2); }
  return Buffer.concat([head, payload]);
}
function wsClose() { return Buffer.from([0x88, 0x00]); }

function wsSend(client, obj) {
  if (!client || client.dead) return;
  try { client.socket.write(wsFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  catch (e) { client.dead = true; }
}

/* ------------------------------ комнаты ----------------------------------- */
let nextId = 1;
const clients = new Map();       // id -> {id, socket, room, host, alive}
const rooms = new Map();         // name -> {name, pass, map, vx, max, members:Set, mods:[]}

function roomInfo(r) {
  return { name: r.name, map: r.map, n: r.members.size, max: r.max, lock: !!r.pass };
}
function roomsList() { return [...rooms.values()].map(roomInfo); }
function roomMembers(r) { return [...r.members].map(id => clients.get(id)).filter(Boolean); }
function broadcast(r, obj, exceptId) {
  for (const c of roomMembers(r)) if (c.id !== exceptId) wsSend(c, obj);
}
function sendRoomsToAll() {
  const list = roomsList();
  for (const c of clients.values()) if (!c.room) wsSend(c, { t: 'rooms', rooms: list });
}
function leaveRoom(c) {
  if (!c.room) return;
  const r = rooms.get(c.room);
  c.room = null;
  if (!r) return;
  r.members.delete(c.id);
  broadcast(r, { t: 'gone', id: c.id });
  if (r.members.size === 0) {
    rooms.delete(r.name);
  } else if (r.host === c.id) {
    r.host = [...r.members][0];               // новый хост
    const hc = clients.get(r.host);
    if (hc) { hc.host = true; broadcast(r, { t: 'host', id: r.host }); }
  }
  sendRoomsToAll();
}

/* --------------------------- логика сообщений ----------------------------- */
function handle(c, m) {
  switch (m.t) {
    case 'list': {
      wsSend(c, { t: 'rooms', rooms: roomsList() });
      break;
    }
    case 'create': {
      leaveRoom(c);
      const name = String(m.name || 'room').slice(0, 40) || 'room';
      if (rooms.has(name)) { wsSend(c, { t: 'err', m: 'Комната «' + name + '» уже есть' }); break; }
      const r = {
        name, pass: String(m.pass || ''), map: String(m.map || 'construct'),
        vx: +m.vx || 0.4, max: Math.min(MAX_PLAYERS, +m.max || MAX_PLAYERS),
        members: new Set([c.id]), host: c.id, mods: []
      };
      rooms.set(name, r);
      c.room = name; c.host = true;
      wsSend(c, { t: 'joined', id: c.id, host: true, room: name, map: r.map, vx: r.vx });
      console.log('[комната] создана «%s» карта %s (игрок %d)', name, r.map, c.id);
      sendRoomsToAll();
      break;
    }
    case 'join': {
      const name = String(m.name || '');
      const r = rooms.get(name);
      if (!r) { wsSend(c, { t: 'err', m: 'Комната «' + name + '» не найдена' }); break; }
      if (r.pass && String(m.pass || '') !== r.pass) { wsSend(c, { t: 'err', m: 'Неверный пароль' }); break; }
      if (r.members.size >= r.max) { wsSend(c, { t: 'err', m: 'Комната заполнена' }); break; }
      leaveRoom(c);
      r.members.add(c.id); c.room = name; c.host = (r.host === c.id);
      wsSend(c, { t: 'joined', id: c.id, host: c.host, room: name, map: r.map, vx: r.vx });
      broadcast(r, { t: 'host', id: r.host });            // все узнают, кто хост
      if (r.mods && r.mods.length) wsSend(c, { t: 'mods', mods: r.mods });
      console.log('[комната] игрок %d вошёл в «%s» (%d/%d)', c.id, name, r.members.size, r.max);
      sendRoomsToAll();
      break;
    }
    case 'leave': {
      leaveRoom(c);
      break;
    }
    case 'msg': {
      const r = rooms.get(c.room);
      if (!r) break;
      broadcast(r, { t: 'm', from: c.id, d: m.d });
      break;
    }
    case 'shareMods': {
      const r = rooms.get(c.room);
      if (!r) break;
      if (r.host !== c.id) { wsSend(c, { t: 'err', m: 'Моды раздаёт только хост' }); break; }
      const mods = Array.isArray(m.mods) ? m.mods.slice(0, 40).map(safeMod) : [];
      r.mods = mods;
      broadcast(r, { t: 'mods', mods }, c.id);
      wsSend(c, { t: 'err', m: '📤 Моды розданы: ' + mods.length + ' (без кода)' });
      console.log('[моды] комната «%s»: роздано %d мод(ов)', r.name, mods.length);
      break;
    }
    default: break;
  }
}
/* из мода вырезаем всё исполняемое: чужой код не должен прилетать по сети */
function safeMod(m) {
  const c = JSON.parse(JSON.stringify(m || {}));
  delete c.script; delete c.js; delete c.scripts;
  if (Array.isArray(c.files)) c.files = c.files.filter(f => !f || typeof f.code !== 'string');
  delete c.permissions;
  return c;
}

/* ------------------------------ статика ----------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.rmod': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '') {
    res.writeHead(302, { Location: '/rphysics/index.html' }); return res.end();
  }
  if (url === '/rmodder') { res.writeHead(302, { Location: '/rmodder.html' }); return res.end(); }
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // красивая 404 с подсказкой
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>Нет файла <b>' + url + '</b>. Открой <a href="/rphysics/index.html">/rphysics/index.html</a></p>');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'Content-Length': st.size
    });
    fs.createReadStream(file).pipe(res);
  });
});

/* ---------------------------- WS upgrade ---------------------------------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  const c = { id: nextId++, socket, room: null, host: false, dead: false, buf: Buffer.alloc(0), frag: null };
  clients.set(c.id, c);
  console.log('[+] игрок %d подключился (%d онлайн)', c.id, clients.size);

  socket.on('data', chunk => {
    c.buf = Buffer.concat([c.buf, chunk]);
    if (c.buf.length > MAX_PAYLOAD * 2) { closeClient(c); return; }
    // разбираем сколько угодно кадров в буфере
    for (;;) {
      const b = c.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0F;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7F;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_PAYLOAD) { closeClient(c); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let mask = null;
      if (masked) { mask = b.subarray(off, off + 4); off += 4; }
      let payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      c.buf = b.subarray(need);

      if (op === 0x8) { closeClient(c); return; }          // close
      if (op === 0x9) { try { socket.write(wsPong(payload)); } catch (e) { } continue; }
      if (op === 0xA) continue;                            // pong
      if (op === 0x0) {                                    // продолжение
        if (c.frag) { c.frag = Buffer.concat([c.frag, payload]); payload = c.frag; }
        else continue;
        if (!fin) continue;
        c.frag = null;
      } else if (!fin) { c.frag = payload; continue; }

      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (msg && typeof msg === 'object') {
        try { handle(c, msg); } catch (e) { console.warn('ошибка сообщения:', e.message); }
      }
    }
  });
  socket.on('error', () => closeClient(c));
  socket.on('close', () => closeClient(c));

  function closeClient(cl) {
    if (cl.dead) return;
    cl.dead = true;
    try { cl.socket.write(wsClose()); } catch (e) { }
    try { cl.socket.destroy(); } catch (e) { }
    leaveRoom(cl);
    clients.delete(cl.id);
    console.log('[-] игрок %d вышел (%d онлайн)', cl.id, clients.size);
  }
  c.close = () => closeClient(c);
});

server.listen(PORT, () => {
  const lan = Object.values(require('os').networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║  Rphysics server запущен                                  ║
  ╚══════════════════════════════════════════════════════════╝
  Игра:      http://localhost:${PORT}/rphysics/index.html
  Моддер:    http://localhost:${PORT}/rmodder.html
  ${lan.length ? 'Для друзей в сети: http://' + lan[0] + ':' + PORT + '/rphysics/index.html' : ''}
  В игре: меню карты → «Мультиплеер» → адрес пустой (= этот сайт) → Создать комнату.
  Останов: Ctrl+C
  `);
  setInterval(() => {   // пульс для прокси (Render/Heroku) и чистка мёртвых
    for (const c of clients.values()) if (c.dead) clients.delete(c.id);
  }, TICK_LOG).unref?.();
});
