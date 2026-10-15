/* =========================================================
   ONEID 인증
   - 브라우저가 ONEID SSO로 받은 토큰을 Bearer로 보냄
   - 서버는 ONEID /api/auth/me 로 검증 (계정/사이트 정지 여부 포함)
   ========================================================= */
import { q } from './db.js';

export const ONEID_URL = (process.env.ONEID_URL || 'http://localhost:8000').replace(/\/$/, '');
export const CLIENT_ID = process.env.ONEID_CLIENT_ID || 'neonstrip';

const CACHE_MS = 60_000;
const cache = new Map(); // token -> { user, until }

export class AuthError extends Error {
  constructor(msg, status = 401) { super(msg); this.status = status; }
}

function decodePayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

/** 토큰 검증 → { id, name } (게임 플레이어 행도 보장) */
export async function verifyToken(token) {
  if (!token) throw new AuthError('로그인이 필요합니다.');
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;

  let res;
  try {
    res = await fetch(`${ONEID_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new AuthError('ONEID 서버에 연결할 수 없습니다.', 503);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    cache.delete(token);
    throw new AuthError(body.detail || '로그인이 만료되었습니다.', res.status === 403 ? 403 : 401);
  }
  const me = await res.json();

  // 서명은 ONEID가 검증했으므로 payload 신뢰 가능 → 이 게임용 SSO 토큰인지 확인
  const p = decodePayload(token);
  if (!p || p.mode !== 'sso' || p.client_id !== CLIENT_ID) {
    throw new AuthError('이 게임용 로그인 토큰이 아닙니다.');
  }

  const user = { id: String(me.id), name: String(me.nickname || me.username).slice(0, 20) };
  await q(
    `INSERT INTO ns_players (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_seen = now()`,
    [user.id, user.name]);

  const until = Math.min(Date.now() + CACHE_MS, (p.exp || 0) * 1000);
  cache.set(token, { user, until });
  return user;
}

export function bearer(req) {
  const h = req.headers.authorization || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

export async function requireAuth(req, res, next) {
  try {
    req.user = await verifyToken(bearer(req));
    next();
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
}, 5 * 60_000).unref();
