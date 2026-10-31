/* =========================================================
   슬롯 스핀 (서버에서 난수 결정)
   ========================================================= */
import crypto from 'node:crypto';
import { tx, lockPlayers, adjust } from './db.js';
import { SYMBOLS, LINES, BETS, CHERRY_PAIR, JACKPOT_SEED, JACKPOT_RATE, ECON } from './rules.js';
import { collectOverdue, GameError } from './loans.js';
import { flush } from './realtime.js';
import { getJarketBuffs } from './jarketBuffs.js';

const TOTAL_W = SYMBOLS.reduce((a, s) => a + s.w, 0);
function randomSymbol() {
  let r = crypto.randomInt(TOTAL_W);
  for (const s of SYMBOLS) { if ((r -= s.w) < 0) return s.s; }
  return SYMBOLS[0].s;
}

function evaluate(grid, bet, cherryMultiplier = 1.0) {
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
      const amt = lineBet * CHERRY_PAIR * cherryMultiplier;
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

    // 1. 유저 보유 자켓마트 아이템 스킬 버프 로드
    const buffs = await getJarketBuffs(c, userId);

    // 2. 슬롯 릴 및 기본 당첨 계산 (체리 배율 증폭 반영)
    const grid = [0, 1, 2].map(() => [randomSymbol(), randomSymbol(), randomSymbol()]);
    const { wins, total, jackpotLine } = evaluate(grid, bet, buffs.cherryMultiplier);

    // 3. 자켓마트 스킬 버프 연산:
    let baseWin = total;
    let buffedWin = 0;
    let insuranceRefund = 0;
    let win = total;

    // A) 당첨금 배율 증폭 (x1.2 ~ x10.0)
    if (total > 0 && buffs.multiplier > 1.0) {
      buffedWin = Math.round(total * buffs.multiplier);
      win = buffedWin;
    }

    // B) 꽝 연패 안심 보험 환급 (30% ~ 70%)
    if (total === 0 && buffs.lossShieldRate > 0) {
      insuranceRefund = Math.round(bet * buffs.lossShieldRate);
      win += insuranceRefund;
    }

    // C) 스핀당 고정 추가 칩 보너스 (+$2 ~ +$50)
    if (buffs.flatBonus > 0) {
      win += buffs.flatBonus;
    }

    // 잭팟 풀 (전 유저 공유)
    let { rows: [{ value: jackpot }] } = await c.query(
      `UPDATE ns_meta SET value = value + $1 WHERE key = 'jackpot' RETURNING value`,
      [Math.round(bet * JACKPOT_RATE)]);
    let jackpotWon = 0;
    if (jackpotLine) {
      jackpotWon = jackpot;
      win += jackpot;
      await c.query(`UPDATE ns_meta SET value = $1 WHERE key = 'jackpot'`, [JACKPOT_SEED]);
      jackpot = JACKPOT_SEED;
    }

    await c.query('UPDATE ns_players SET spins = spins + 1, last_seen = now() WHERE id = $1', [userId]);
    let balance = await adjust(c, userId, win - bet, 'spin');

    // D) 파산 방지 부활 실드 (매머드 등)
    let resurrected = false;
    if (balance < BETS[0] && buffs.resurrectionAmount > 0) {
      balance = await adjust(c, userId, buffs.resurrectionAmount, 'jarket_mammoth_shield');
      resurrected = true;
      ev.push({ feed: `🍖 ${me.name}님 매머드 부활 실드로 +$${buffs.resurrectionAmount.toLocaleString()} 칩 긴급 충전!`, level: 'hot' });
    }

    // 연체 중이면 당첨금의 일부를 자동 압류
    let seized = 0;
    if (win > 0) {
      seized = await collectOverdue(c, userId, win * ECON.SEIZE_RATIO, ev);
      balance -= seized;
    }

    if (jackpotWon) ev.push({ feed: `🎰 ${me.name}님 프로그레시브 잭팟 $${win.toLocaleString('en-US')} 획득!!!`, level: 'hot' });
    else if (win >= bet * 50) ev.push({ feed: `💎 ${me.name}님 MEGA WIN +$${win.toLocaleString('en-US')}`, level: 'hot' });
    else if (win >= bet * 15 && win >= 1000) ev.push({ feed: `🔥 ${me.name}님 BIG WIN +$${win.toLocaleString('en-US')}` });

    return {
      grid,
      wins,
      win,
      baseWin,
      bet,
      jackpotWon,
      jackpot,
      balance,
      seized,
      buffs: {
        multiplier: buffs.multiplier,
        flatBonus: buffs.flatBonus,
        lossShieldRate: buffs.lossShieldRate,
        insuranceRefund,
        resurrected,
        activeBuffs: buffs.activeBuffs
      }
    };
  });
  flush(ev);
  return result;
}
