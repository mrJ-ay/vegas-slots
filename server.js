/* =========================================================
   NEON STRIP — 게임 서버 (Render)
   Express + WebSocket + Neon Postgres + ONEID SSO
   ========================================================= */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { q, tx, initSchema, lockPlayers, adjust, addCredit } from './lib/db.js';
import { requireAuth, ONEID_URL, CLIENT_ID } from './lib/auth.js';
import { attach, broadcast, flush, onlineCount } from './lib/realtime.js';
import { SYMBOLS, LINES, BETS, CHERRY_PAIR, ECON, NPC_LENDERS } from './lib/rules.js';
import { spin } from './lib/slots.js';
import {
  GameError, owedNow, lenderLabel, npcStatus, borrowNpc, repay,
  createOffer, cancelOffer, acceptOffer, overdueSweep,
} from './lib/loans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5504);
const H = 3_600_000;

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL 이 없습니다. .env 를 확인하세요 (.env.example 참고).');
  process.exit(1);
}
await initSchema();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 공개 ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => res.json({
  oneidUrl: (process.env.ONEID_PUBLIC_URL || ONEID_URL).replace(/\/$/, ''),
  clientId: CLIENT_ID,
  symbols: SYMBOLS.map(({ s, pay }) => ({ s, pay })),
  lines: LINES,
  bets: BETS,
  cherryPair: CHERRY_PAIR,
  econ: {
    rateMaxPct: ECON.RATE_MAX_PCT, termMin: ECON.TERM_MIN_H, termMax: ECON.TERM_MAX_H,
    offerMin: ECON.OFFER_MIN, offerMax: ECON.OFFER_MAX, seizeFloor: ECON.SEIZE_FLOOR,
    newbieHours: ECON.NEWBIE_HOURS, newbieCap: ECON.NEWBIE_P2P_BORROW_CAP,
  },
  npc: NPC_LENDERS,
}));

// ---------- 랭킹 (순자산 = 잔고 + 묶어둔 돈 + 받을 돈 − 갚을 돈) ----------
let board = { top: [], ranks: new Map(), json: '' };
async function computeBoard() {
  const [{ rows: players }, { rows: loans }, { rows: escrow }] = await Promise.all([
    q('SELECT id, name, balance, credit, bankruptcies FROM ns_players'),
    q(`SELECT * FROM ns_loans WHERE status = 'active'`),
    q(`SELECT owner_id, sum(amount)::bigint AS s FROM ns_offers WHERE status = 'open' AND kind = 'lend' GROUP BY owner_id`),
  ]);
  const now = Date.now();
  const net = new Map(players.map(p => [p.id, p.balance]));
  const defaulter = new Set();
  for (const e of escrow) net.set(e.owner_id, (net.get(e.owner_id) || 0) + e.s);
  for (const l of loans) {
    const owed = owedNow(l, now);
    net.set(l.borrower_id, (net.get(l.borrower_id) || 0) - owed);
    if (net.has(l.lender_id)) net.set(l.lender_id, net.get(l.lender_id) + owed);
    if (new Date(l.due_at).getTime() < now) defaulter.add(l.borrower_id);
  }
  const sorted = players
    .map(p => ({ id: p.id, name: p.name, net: Math.round(net.get(p.id)), credit: p.credit, bankruptcies: p.bankruptcies, defaulter: defaulter.has(p.id) }))
    .sort((a, b) => b.net - a.net);
  const ranks = new Map(sorted.map((p, i) => [p.id, i + 1]));
  const top = sorted.slice(0, 20);
  const json = JSON.stringify(top);
  const changed = json !== board.json;
  board = { top, ranks, json };
  if (changed) broadcast({ type: 'board', top });
}

app.get('/api/leaderboard', requireAuth, (req, res) =>
  res.json({ top: board.top, myRank: board.ranks.get(req.user.id) || null }));

// ---------- 내 상태 ----------
app.get('/api/state', requireAuth, async (req, res) => {
  const uid = req.user.id;
  const [{ rows: [me] }, { rows: loans }, { rows: offers }, { rows: [{ value: jackpot }] }] = await Promise.all([
    q('SELECT * FROM ns_players WHERE id = $1', [uid]),
    q(`SELECT * FROM ns_loans WHERE status = 'active' AND (borrower_id = $1 OR lender_id = $1) ORDER BY due_at`, [uid]),
    q(`SELECT * FROM ns_offers WHERE owner_id = $1 AND status = 'open' ORDER BY created_at DESC`, [uid]),
    q(`SELECT value FROM ns_meta WHERE key = 'jackpot'`),
  ]);
  const ids = [...new Set(loans.flatMap(l => [l.borrower_id, l.lender_id]))].filter(i => !i.startsWith('npc:'));
  const { rows: nameRows } = await q('SELECT id, name, credit FROM ns_players WHERE id = ANY($1)', [ids]);
  const names = Object.fromEntries(nameRows.map(r => [r.id, r.name]));
  const now = Date.now();
  const view = l => ({
    id: l.id, principal: l.principal, rate: l.rate, owed: Math.ceil(owedNow(l, now)),
    dueAt: l.due_at, overdue: new Date(l.due_at).getTime() < now, repaid: l.repaid, seized: l.seized,
  });
  const borrowed = loans.filter(l => l.borrower_id === uid).map(l => ({ ...view(l), who: lenderLabel(l, names), npc: l.lender_id.startsWith('npc:') }));
  const lent = loans.filter(l => l.lender_id === uid).map(l => ({ ...view(l), who: names[l.borrower_id] || '???' }));
  const activeNpc = new Set(borrowed.filter(b => b.npc).map(b => loans.find(l => l.id === b.id).lender_id.slice(4)));
  const cooldownLeft = me.last_bankrupt_at
    ? Math.max(0, ECON.BANKRUPT_COOLDOWN_MIN * 60_000 - (now - new Date(me.last_bankrupt_at).getTime())) : 0;

  res.json({
    me: {
      id: me.id, name: me.name, balance: me.balance, credit: me.credit, spins: me.spins,
      bankruptcies: me.bankruptcies, createdAt: me.created_at,
      newbie: now - new Date(me.created_at).getTime() < ECON.NEWBIE_HOURS * H,
      bankruptCooldownMs: cooldownLeft,
    },
    jackpot,
    debt: borrowed.reduce((a, b) => a + b.owed, 0),
    receivable: lent.reduce((a, b) => a + b.owed, 0),
    escrow: offers.filter(o => o.kind === 'lend').reduce((a, o) => a + o.amount, 0),
    borrowed, lent,
    myOffers: offers.map(o => ({ id: o.id, kind: o.kind, amount: o.amount, rate: o.rate, termHours: o.term_hours, minCredit: o.min_credit, note: o.note })),
    npc: NPC_LENDERS.map(n => ({ id: n.id, ...npcStatus(n, me, activeNpc) })),
    myRank: board.ranks.get(uid) || null,
    online: onlineCount(),
  });
});

// ---------- 게임 ----------
app.post('/api/spin', requireAuth, async (req, res) => res.json(await spin(req.user.id, req.body?.bet)));

app.post('/api/bankrupt', requireAuth, async (req, res) => {
  const ev = [];
  await tx(async c => {
    const uid = req.user.id;
    const me = (await lockPlayers(c, [uid]))[uid];
    if (me.balance >= BETS[0]) throw new GameError('아직 돈이 남아 있습니다.');
    if (me.last_bankrupt_at && Date.now() - new Date(me.last_bankrupt_at).getTime() < ECON.BANKRUPT_COOLDOWN_MIN * 60_000) {
      throw new GameError(`파산 신청은 ${ECON.BANKRUPT_COOLDOWN_MIN}분에 한 번만 가능합니다.`);
    }
    await adjust(c, uid, ECON.START_MONEY, 'bankrupt_reset');
    await c.query('UPDATE ns_players SET bankruptcies = bankruptcies + 1, last_bankrupt_at = now() WHERE id = $1', [uid]);
    await addCredit(c, uid, ECON.CREDIT_BANKRUPT);
    ev.push({ feed: `💀 ${me.name}님 파산 신청… 빚은 그대로, $${ECON.START_MONEY.toLocaleString()}로 재기 도전`, level: 'bad' }, { refresh: uid });
  });
  flush(ev);
  res.json({ ok: true });
});

// ---------- 대출 ----------
app.post('/api/npc/:id/borrow', requireAuth, async (req, res) => {
  await borrowNpc(req.user.id, req.params.id, req.body?.amount);
  res.json({ ok: true });
});

app.post('/api/loans/:id/repay', requireAuth, async (req, res) =>
  res.json(await repay(req.user.id, Number(req.params.id), req.body?.amount ?? null)));

app.get('/api/market', requireAuth, async (req, res) => {
  const { rows } = await q(`
    SELECT o.*, p.name, p.credit, p.created_at AS owner_created,
      EXISTS (SELECT 1 FROM ns_loans l WHERE l.borrower_id = o.owner_id AND l.status = 'active' AND l.due_at < now()) AS defaulter
    FROM ns_offers o JOIN ns_players p ON p.id = o.owner_id
    WHERE o.status = 'open' ORDER BY o.created_at DESC LIMIT 100`);
  const now = Date.now();
  res.json(rows.map(o => ({
    id: o.id, kind: o.kind, amount: o.amount, rate: o.rate, termHours: o.term_hours, minCredit: o.min_credit,
    note: o.note, owner: o.name, ownerCredit: o.credit, defaulter: o.defaulter,
    newbie: now - new Date(o.owner_created).getTime() < ECON.NEWBIE_HOURS * H,
    mine: o.owner_id === req.user.id, createdAt: o.created_at,
  })));
});

app.post('/api/offers', requireAuth, async (req, res) => res.json({ id: await createOffer(req.user.id, req.body || {}) }));
app.post('/api/offers/:id/cancel', requireAuth, async (req, res) => { await cancelOffer(req.user.id, Number(req.params.id)); res.json({ ok: true }); });
app.post('/api/offers/:id/accept', requireAuth, async (req, res) => { await acceptOffer(req.user.id, Number(req.params.id)); res.json({ ok: true }); });

// ---------- 에러 ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
  if (err.code === '23514') return res.status(400).json({ error: '잔고가 부족합니다.' }); // balance >= 0 위반
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// ---------- 시작 ----------
const server = http.createServer(app);
attach(server);
server.listen(PORT, () => console.log(`🎰 NEON STRIP → http://localhost:${PORT}  (ONEID: ${ONEID_URL})`));

const safe = fn => () => fn().catch(e => console.error(e));
safe(overdueSweep)();
safe(computeBoard)();
setInterval(safe(overdueSweep), 60_000);
setInterval(safe(computeBoard), 10_000);
