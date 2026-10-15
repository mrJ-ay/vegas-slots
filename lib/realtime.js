/* =========================================================
   실시간 (WebSocket)
   - 서버 → 클라이언트 푸시 전용
   - type: feed | notify | refresh | market | board
   ========================================================= */
import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';

const sockets = new Map(); // userId -> Set<ws>
const feed = [];           // 최근 소식
let wss;

export function attach(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    let user;
    try { user = await verifyToken(token); }
    catch { ws.close(4001, 'unauthorized'); return; }

    ws.userId = user.id;
    ws.isAlive = true;
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    sockets.get(user.id).add(ws);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      const set = sockets.get(user.id);
      set?.delete(ws);
      if (set && !set.size) sockets.delete(user.id);
      broadcast({ type: 'online', count: onlineCount() });
    });
    send(ws, { type: 'hello', feed, online: onlineCount() });
    broadcast({ type: 'online', count: onlineCount() });
  });

  // 끊긴 연결 정리
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000).unref();
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
export function onlineCount() { return sockets.size; }

export function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}

export function toUser(userId, msg) {
  for (const ws of sockets.get(userId) || []) send(ws, msg);
}

export function pushFeed(text, level = '') {
  const item = { text, level, at: Date.now() };
  feed.unshift(item);
  feed.length = Math.min(feed.length, 50);
  broadcast({ type: 'feed', item });
}

/** 트랜잭션 안에서 모은 이벤트를 커밋 후 한 번에 발송 */
export function flush(events) {
  const refresh = new Set();
  let market = false;
  for (const e of events) {
    if (e.feed) pushFeed(e.feed, e.level);
    if (e.notify) toUser(e.notify.to, { type: 'notify', text: e.notify.text, level: e.notify.level || '' });
    if (e.refresh) refresh.add(e.refresh);
    if (e.market) market = true;
  }
  for (const id of refresh) toUser(id, { type: 'refresh' });
  if (market) broadcast({ type: 'market' });
}
