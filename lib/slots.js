/* =========================================================
   슬롯 스핀 (서버에서 난수 결정)
   ========================================================= */
import crypto from 'node:crypto';
import { tx, lockPlayers, adjust } from './db.js';
import { SYMBOLS, LINES, BETS, CHERRY_PAIR, JACKPOT_SEED, JACKPOT_RATE, ECON } from './rules.js';
import { collectOverdue, GameError } from './loans.js';
import { flush } from './realtime.js';

const TOTAL_W = SYMBOLS.reduce((a, s) => a + s.w, 0);
function randomSymbol() {
  let r = crypto.randomInt(TOTAL_W);
  for (const s of SYMBOLS) { if ((r -= s.w) < 0) return s.s; }
  return SYMBOLS[0].s;
}

function evaluate(grid, bet) {
  const lineBet = bet / LINES.length;
  const wins = [];
  let total = 0, jackpotLine = false;
  LINES.forEach((line, li) => {
    const syms = line.rows.map((r, c) => grid[c][r]);
    if (syms[0] === syms[1] && syms[1] === syms[2]) {
      const def = SYMBOLS.find(s => s.s === syms[0]);
      const amt = lineBet * def.pay;
      if (def.s === '7️⃣' && li === 0) jackpotLine = true;
      wins.push({ li, cells: [0, 1, 2], amt });
      total += amt;
    } else if (syms[0] === '🍒' && syms[1] === '🍒') {
      const amt = lineBet * CHERRY_PAIR;
      wins.push({ li, cells: [0, 1], amt });
      total += amt;
    }
  });
  return { wins, total: Math.round(total), jackpotLine };
}

const lastSpin = new Map(); // 연타 방지

export async function spin(userId, bet) {
  bet = Number(bet);
  if (!BETS.includes(bet)) throw new GameError('허용되지 않은 배팅 금액입니다.');
  const now = Date.now();
  if (now - (lastSpin.get(userId) || 0) < 300) throw new GameError('너무 빠릅니다.', 429);
  lastSpin.set(userId, now);

  const ev = [];
  const result = await tx(async c => {
    const me = (await lockPlayers(c, [userId]))[userId];
    if (me.balance < bet) throw new GameError('잔고가 부족합니다.');

    const grid = [0, 1, 2].map(() => [randomSymbol(), randomSymbol(), randomSymbol()]);
    const { wins, total, jackpotLine } = evaluate(grid, bet);

    // 잭팟 풀 (전 유저 공유)
    let { rows: [{ value: jackpot }] } = await c.query(
      `UPDATE ns_meta SET value = value + $1 WHERE key = 'jackpot' RETURNING value`,
      [Math.round(bet * JACKPOT_RATE)]);
    let win = total, jackpotWon = 0;
    if (jackpotLine) {
      jackpotWon = jackpot;
      win += jackpot;
      await c.query(`UPDATE ns_meta SET value = $1 WHERE key = 'jackpot'`, [JACKPOT_SEED]);
      jackpot = JACKPOT_SEED;
    }

    await c.query('UPDATE ns_players SET spins = spins + 1, last_seen = now() WHERE id = $1', [userId]);
    let balance = await adjust(c, userId, win - bet, 'spin');

    // 연체 중이면 당첨금의 일부를 자동 압류
    let seized = 0;
    if (win > 0) {
      seized = await collectOverdue(c, userId, win * ECON.SEIZE_RATIO, ev);
      balance -= seized;
    }

    if (jackpotWon) ev.push({ feed: `🎰 ${me.name}님 프로그레시브 잭팟 $${win.toLocaleString('en-US')} 획득!!!`, level: 'hot' });
    else if (win >= bet * 50) ev.push({ feed: `💎 ${me.name}님 MEGA WIN +$${win.toLocaleString('en-US')}`, level: 'hot' });
    else if (win >= bet * 15 && win >= 1000) ev.push({ feed: `🔥 ${me.name}님 BIG WIN +$${win.toLocaleString('en-US')}` });

    return { grid, wins, win, bet, jackpotWon, jackpot, balance, seized };
  });
  flush(ev);
  return result;
}
