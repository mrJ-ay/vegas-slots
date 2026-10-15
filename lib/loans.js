/* =========================================================
   대출 엔진: 이자 계산, 상환, 압류, 유저 간 대출 게시판, NPC 사채
   모든 돈 이동은 트랜잭션 + 원장 기록
   ========================================================= */
import { tx, q, lockPlayers, adjust, addCredit } from './db.js';
import { ECON, NPC_LENDERS, npcById } from './rules.js';
import { flush } from './realtime.js';

const H = 3_600_000;
export class GameError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
const isNpc = id => id.startsWith('npc:');
const money = n => '$' + Math.round(n).toLocaleString('en-US');

// ---------- 이자 ----------
/** 현재 시점의 빚 (기한 전 r, 기한 후 r×2 복리, 원금 10배 상한) */
export function owedNow(loan, now = Date.now()) {
  const r = Number(loan.rate);
  const due = new Date(loan.due_at).getTime();
  let t0 = new Date(loan.accrued_at).getTime();
  let base = Number(loan.owed_base);
  if (now <= due) {
    base *= Math.pow(1 + r, Math.max(0, now - t0) / H);
  } else {
    if (t0 < due) { base *= Math.pow(1 + r, (due - t0) / H); t0 = due; }
    base *= Math.pow(1 + r * ECON.OVERDUE_RATE_MULT, Math.max(0, now - t0) / H);
  }
  return Math.min(base, Number(loan.principal) * ECON.OWED_CAP_MULT);
}

export function lenderLabel(loan, names = {}) {
  if (isNpc(loan.lender_id)) { const n = npcById(loan.lender_id.slice(4)); return n ? `${n.ava} ${n.name}` : loan.lender_id; }
  return names[loan.lender_id] || '???';
}

// ---------- 상환 / 압류 (트랜잭션 내부) ----------
/**
 * 빚 일부 또는 전부 지불. 빌린 사람 행은 호출자가 잠가 둔 상태여야 함.
 * kind: 'repay' | 'seize'
 */
async function applyPayment(c, loan, amount, kind, ev, names) {
  const now = Date.now();
  const owed = owedNow(loan, now);
  const pay = Math.min(Math.floor(amount), Math.ceil(owed));
  if (pay <= 0) return 0;
  const left = owed - pay;
  const closed = left < 1;

  await c.query(
    `UPDATE ns_loans SET owed_base = $2, accrued_at = to_timestamp($3 / 1000.0),
       repaid = repaid + $4, seized = seized + $5,
       status = $6, closed_at = CASE WHEN $6 = 'paid' THEN now() ELSE NULL END
     WHERE id = $1`,
    [loan.id, closed ? 0 : left, now, kind === 'repay' ? pay : 0, kind === 'seize' ? pay : 0, closed ? 'paid' : 'active']);

  await adjust(c, loan.borrower_id, -pay, kind === 'repay' ? 'loan_repay' : 'loan_seized', `loan:${loan.id}`);
  if (!isNpc(loan.lender_id)) {
    await adjust(c, loan.lender_id, pay, kind === 'repay' ? 'loan_repaid_in' : 'loan_seized_in', `loan:${loan.id}`);
    ev.push({ refresh: loan.lender_id });
  }

  const bName = names[loan.borrower_id] || '???';
  const lName = lenderLabel(loan, names);
  if (kind === 'seize') {
    await addCredit(c, loan.borrower_id, ECON.CREDIT_SEIZED);
    ev.push({ notify: { to: loan.borrower_id, text: `🥊 ${lName}에게 ${money(pay)} 압류당함`, level: 'bad' } });
    if (!isNpc(loan.lender_id)) ev.push({ notify: { to: loan.lender_id, text: `💰 ${bName}님 연체금 ${money(pay)} 회수`, level: 'win' } });
  }
  if (closed) {
    const onTime = now <= new Date(loan.due_at).getTime();
    if (kind === 'repay') await addCredit(c, loan.borrower_id, onTime ? ECON.CREDIT_REPAY_ON_TIME : ECON.CREDIT_REPAY_LATE);
    ev.push({ feed: `✅ ${bName}님이 ${lName}에게 빚 완납${onTime ? '' : ' (연체 후)'}`, level: 'hot' });
    if (!isNpc(loan.lender_id)) ev.push({ notify: { to: loan.lender_id, text: `✅ ${bName}님이 빚을 모두 갚았습니다`, level: 'win' } });
  } else if (kind === 'repay' && !isNpc(loan.lender_id)) {
    ev.push({ notify: { to: loan.lender_id, text: `💵 ${bName}님이 ${money(pay)} 상환`, level: 'win' } });
  }
  ev.push({ refresh: loan.borrower_id });
  return pay;
}

async function namesFor(c, ids) {
  const real = [...new Set(ids.filter(id => id && !isNpc(id)))];
  if (!real.length) return {};
  const { rows } = await c.query('SELECT id, name FROM ns_players WHERE id = ANY($1)', [real]);
  return Object.fromEntries(rows.map(r => [r.id, r.name]));
}

/**
 * 연체된 빚 자동 압류 (빌린 사람 행이 잠긴 상태에서 호출)
 * budget: 압류에 쓸 수 있는 최대 금액
 */
export async function collectOverdue(c, borrowerId, budget, ev) {
  budget = Math.floor(budget);
  if (budget <= 0) return 0;
  const { rows: loans } = await c.query(
    `SELECT * FROM ns_loans WHERE borrower_id = $1 AND status = 'active' AND due_at < now()
     ORDER BY due_at FOR UPDATE`, [borrowerId]);
  if (!loans.length) return 0;
  const names = await namesFor(c, [borrowerId, ...loans.map(l => l.lender_id)]);
  let total = 0;
  for (const loan of loans) {
    if (budget - total <= 0) break;
    total += await applyPayment(c, loan, budget - total, 'seize', ev, names);
  }
  return total;
}

// ---------- 직접 상환 ----------
export async function repay(userId, loanId, amount) {
  const ev = [];
  const result = await tx(async c => {
    const me = (await lockPlayers(c, [userId]))[userId];
    const { rows } = await c.query(
      `SELECT * FROM ns_loans WHERE id = $1 AND borrower_id = $2 AND status = 'active' FOR UPDATE`, [loanId, userId]);
    if (!rows.length) throw new GameError('해당 빚이 없습니다.');
    const loan = rows[0];
    const owed = Math.ceil(owedNow(loan));
    const want = amount == null ? owed : Math.floor(Number(amount));
    if (!Number.isFinite(want) || want <= 0) throw new GameError('상환 금액이 올바르지 않습니다.');
    const pay = Math.min(want, owed, me.balance);
    if (pay <= 0) throw new GameError('갚을 돈이 없습니다.');
    const names = await namesFor(c, [userId, loan.lender_id]);
    return { paid: await applyPayment(c, loan, pay, 'repay', ev, names) };
  });
  flush(ev);
  return result;
}

// ---------- NPC 사채 ----------
export function npcMax(npc, credit) {
  const factor = Math.max(0.1, Math.min(1, (credit - 300) / 550));
  const cap = npc.tag === 'shark' ? npc.cap * (0.5 + factor / 2) : npc.cap * factor;
  return Math.floor(cap / 10) * 10;
}
export function npcStatus(npc, player, activeNpcIds) {
  const blacklist = Array.isArray(player?.npc_blacklist) ? player.npc_blacklist : [];
  if (blacklist.includes(npc.id)) return { ok: false, why: '⛔ 당신을 블랙리스트에 올림' };
  if (activeNpcIds.has(npc.id)) return { ok: false, why: '이미 빌린 돈이 있음' };
  if (player.credit < npc.minCredit) return { ok: false, why: `신용 ${npc.minCredit} 이상 필요` };
  return { ok: true, max: npcMax(npc, player.credit) };
}

export async function borrowNpc(userId, npcId, amount) {
  const npc = npcById(npcId);
  if (!npc) throw new GameError('없는 대출업자입니다.');
  amount = Math.floor(Number(amount));
  const ev = [];
  await tx(async c => {
    const me = (await lockPlayers(c, [userId]))[userId];
    const { rows } = await c.query(
      `SELECT lender_id FROM ns_loans WHERE borrower_id = $1 AND status = 'active' AND lender_id LIKE 'npc:%'`, [userId]);
    const st = npcStatus(npc, me, new Set(rows.map(r => r.lender_id.slice(4))));
    if (!st.ok) throw new GameError(st.why);
    if (!(amount >= 10 && amount <= st.max)) throw new GameError(`10 ~ ${money(st.max)} 사이로 빌릴 수 있습니다.`);
    const { rows: [loan] } = await c.query(
      `INSERT INTO ns_loans (lender_id, borrower_id, principal, rate, owed_base, due_at)
       VALUES ($1, $2, $3::bigint, $4, $5::double precision, now() + ($6 || ' hours')::interval) RETURNING id`,
      [`npc:${npc.id}`, userId, amount, npc.rate, amount, npc.term]);
    await adjust(c, userId, amount, 'loan_in', `loan:${loan.id}`);
    await addCredit(c, userId, ECON.CREDIT_BORROW);
    ev.push({ feed: `🤝 ${me.name}님이 ${npc.ava} ${npc.name}에게 ${money(amount)} 빌림` }, { refresh: userId });
  });
  flush(ev);
}

// ---------- 유저 대출 게시판 ----------
function validateOffer(b) {
  const kind = b.kind;
  const amount = Math.floor(Number(b.amount));
  const ratePct = Number(b.ratePct);
  const term = Math.floor(Number(b.termHours));
  const minCredit = Math.floor(Number(b.minCredit ?? 300));
  const note = String(b.note ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  if (!['lend', 'borrow'].includes(kind)) throw new GameError('종류가 올바르지 않습니다.');
  if (!(amount >= ECON.OFFER_MIN && amount <= ECON.OFFER_MAX)) throw new GameError(`금액은 ${money(ECON.OFFER_MIN)} ~ ${money(ECON.OFFER_MAX)}`);
  if (!(ratePct >= 0 && ratePct <= ECON.RATE_MAX_PCT)) throw new GameError(`이자는 시간당 0 ~ ${ECON.RATE_MAX_PCT}%`);
  if (!(term >= ECON.TERM_MIN_H && term <= ECON.TERM_MAX_H)) throw new GameError(`기한은 ${ECON.TERM_MIN_H} ~ ${ECON.TERM_MAX_H}시간`);
  if (!(minCredit >= 300 && minCredit <= 850)) throw new GameError('최소 신용은 300 ~ 850');
  return { kind, amount, rate: Math.round(ratePct * 1000) / 100000, term, minCredit, note };
}

export async function createOffer(userId, body) {
  const o = validateOffer(body);
  const ev = [];
  const id = await tx(async c => {
    const me = (await lockPlayers(c, [userId]))[userId];
    const { rows: [{ n }] } = await c.query(
      `SELECT count(*)::int AS n FROM ns_offers WHERE owner_id = $1 AND kind = $2 AND status = 'open'`, [userId, o.kind]);
    const limit = o.kind === 'lend' ? ECON.MAX_OPEN_LEND : ECON.MAX_OPEN_BORROW;
    if (n >= limit) throw new GameError(`열린 글은 최대 ${limit}개까지입니다.`);
    if (o.kind === 'lend' && me.balance < o.amount) throw new GameError('잔고가 부족합니다.');

    const { rows: [row] } = await c.query(
      `INSERT INTO ns_offers (kind, owner_id, amount, rate, term_hours, min_credit, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [o.kind, userId, o.amount, o.rate, o.term, o.kind === 'lend' ? o.minCredit : 300, o.note || null]);
    // 빌려주기 글은 돈을 미리 묶어둠 (이중 사용 방지)
    if (o.kind === 'lend') await adjust(c, userId, -o.amount, 'offer_escrow', `offer:${row.id}`);
    ev.push(
      { feed: o.kind === 'lend'
          ? `💼 ${me.name}님이 ${money(o.amount)} 빌려줍니다 (시간당 ${(o.rate * 100).toFixed(1)}%, ${o.term}시간)`
          : `🙏 ${me.name}님이 ${money(o.amount)} 구합니다 (시간당 ${(o.rate * 100).toFixed(1)}%, ${o.term}시간)` },
      { market: true }, { refresh: userId });
    return row.id;
  });
  flush(ev);
  return id;
}

export async function cancelOffer(userId, offerId) {
  const ev = [];
  await tx(async c => {
    await lockPlayers(c, [userId]);
    const { rows } = await c.query(
      `SELECT * FROM ns_offers WHERE id = $1 AND owner_id = $2 AND status = 'open' FOR UPDATE`, [offerId, userId]);
    if (!rows.length) throw new GameError('취소할 수 있는 글이 없습니다.');
    const offer = rows[0];
    await c.query(`UPDATE ns_offers SET status = 'cancelled' WHERE id = $1`, [offer.id]);
    if (offer.kind === 'lend') await adjust(c, userId, offer.amount, 'offer_refund', `offer:${offer.id}`);
    ev.push({ market: true }, { refresh: userId });
  });
  flush(ev);
}

/** 게시글 수락: lend 글이면 내가 빌림, borrow 글이면 내가 빌려줌 */
export async function acceptOffer(userId, offerId) {
  const ev = [];
  await tx(async c => {
    const { rows } = await c.query(`SELECT * FROM ns_offers WHERE id = $1 FOR UPDATE`, [offerId]);
    const offer = rows[0];
    if (!offer || offer.status !== 'open') throw new GameError('이미 마감된 글입니다.', 409);
    if (offer.owner_id === userId) throw new GameError('자기 글은 수락할 수 없습니다.');

    const lenderId = offer.kind === 'lend' ? offer.owner_id : userId;
    const borrowerId = offer.kind === 'lend' ? userId : offer.owner_id;
    const P = await lockPlayers(c, [lenderId, borrowerId]);
    const lender = P[lenderId], borrower = P[borrowerId];

    if (offer.kind === 'lend' && borrower.credit < offer.min_credit) {
      throw new GameError(`신용 ${offer.min_credit} 이상만 빌릴 수 있는 글입니다.`);
    }
    // 빌리는 쪽 한도 (부계정 먹튀 방지)
    const { rows: [agg] } = await c.query(
      `SELECT count(*)::int AS n, COALESCE(sum(principal), 0)::bigint AS total
       FROM ns_loans WHERE borrower_id = $1 AND status = 'active' AND lender_id NOT LIKE 'npc:%'`, [borrowerId]);
    if (agg.n >= ECON.MAX_ACTIVE_P2P_BORROW) throw new GameError(`${borrower.name}님은 이미 유저 빚이 ${agg.n}건입니다.`);
    const newbie = Date.now() - new Date(borrower.created_at).getTime() < ECON.NEWBIE_HOURS * H;
    if (newbie && agg.total + offer.amount > ECON.NEWBIE_P2P_BORROW_CAP) {
      throw new GameError(`가입 ${ECON.NEWBIE_HOURS}시간 이내 계정은 유저 대출 총 ${money(ECON.NEWBIE_P2P_BORROW_CAP)}까지만 빌릴 수 있습니다.`);
    }
    if (offer.kind === 'borrow' && lender.balance < offer.amount) throw new GameError('잔고가 부족합니다.');

    await c.query(`UPDATE ns_offers SET status = 'taken' WHERE id = $1`, [offer.id]);
    const { rows: [loan] } = await c.query(
      `INSERT INTO ns_loans (lender_id, borrower_id, principal, rate, owed_base, due_at)
       VALUES ($1, $2, $3::bigint, $4, $5::double precision, now() + ($6 || ' hours')::interval) RETURNING id`,
      [lenderId, borrowerId, offer.amount, offer.rate, offer.amount, offer.term_hours]);
    if (offer.kind === 'borrow') await adjust(c, lenderId, -offer.amount, 'loan_out', `loan:${loan.id}`);
    await adjust(c, borrowerId, offer.amount, 'loan_in', `loan:${loan.id}`);
    await addCredit(c, borrowerId, ECON.CREDIT_BORROW);

    ev.push(
      { feed: `🤝 ${borrower.name}님이 ${lender.name}님에게 ${money(offer.amount)} 빌림 (시간당 ${(offer.rate * 100).toFixed(1)}%, ${offer.term_hours}시간)`, level: 'hot' },
      { notify: { to: offer.owner_id, text: offer.kind === 'lend'
          ? `🤝 ${borrower.name}님이 당신의 ${money(offer.amount)}을 빌려갔습니다`
          : `🤝 ${lender.name}님이 ${money(offer.amount)}을 빌려줬습니다`, level: 'win' } },
      { market: true }, { refresh: lenderId }, { refresh: borrowerId });
  });
  flush(ev);
}

// ---------- 주기 작업: 연체 처리 ----------
export async function overdueSweep() {
  const ev = [];
  // 1) 새로 연체된 빚 표시 + 신용 하락
  const { rows: fresh } = await q(
    `UPDATE ns_loans SET overdue_notified = true
     WHERE status = 'active' AND due_at < now() AND NOT overdue_notified
     RETURNING id, lender_id, borrower_id`);
  if (fresh.length) {
    const ids = [...new Set(fresh.flatMap(l => [l.borrower_id, l.lender_id]).filter(i => !isNpc(i)))];
    const { rows } = await q('SELECT id, name FROM ns_players WHERE id = ANY($1)', [ids]);
    const names = Object.fromEntries(rows.map(r => [r.id, r.name]));
    for (const l of fresh) {
      await q(`UPDATE ns_players SET credit = GREATEST(${ECON.CREDIT_MIN}, credit + $2) WHERE id = $1`, [l.borrower_id, ECON.CREDIT_OVERDUE]);
      const lName = lenderLabel(l, names);
      ev.push(
        { feed: `🚨 ${names[l.borrower_id]}님이 ${lName}의 빚을 연체했습니다`, level: 'bad' },
        { notify: { to: l.borrower_id, text: `🚨 ${lName} 빚 연체! 이자 2배, 돈을 따면 자동 압류됩니다`, level: 'bad' } },
        { refresh: l.borrower_id });
      if (!isNpc(l.lender_id)) ev.push({ notify: { to: l.lender_id, text: `🚨 ${names[l.borrower_id]}님이 연체 중입니다. 자동 압류가 시작됩니다`, level: 'bad' } });
    }
  }

  // 2) NPC 빚 장기 연체 → 블랙리스트
  await q(
    `UPDATE ns_players p SET npc_blacklist = array_append(p.npc_blacklist, substr(l.lender_id, 5))
     FROM ns_loans l
     WHERE l.borrower_id = p.id AND l.status = 'active' AND l.lender_id LIKE 'npc:%'
       AND l.due_at < now() - ($1 || ' hours')::interval
       AND NOT (substr(l.lender_id, 5) = ANY(COALESCE(p.npc_blacklist, '{}')))`, [ECON.NPC_BLACKLIST_HOURS]);

  // 3) 잔고가 있는 연체자에게서 압류 (최소 잔고는 남김)
  const { rows: debtors } = await q(
    `SELECT DISTINCT p.id FROM ns_players p JOIN ns_loans l ON l.borrower_id = p.id
     WHERE l.status = 'active' AND l.due_at < now() AND p.balance > $1`, [ECON.SEIZE_FLOOR]);
  for (const { id } of debtors) {
    try {
      await tx(async c => {
        const me = (await lockPlayers(c, [id]))[id];
        const budget = (me.balance - ECON.SEIZE_FLOOR) * ECON.SEIZE_RATIO;
        await collectOverdue(c, id, budget, ev);
      });
    } catch (e) { console.error('seize failed', id, e.message); }
  }
  flush(ev);
}

export { NPC_LENDERS };
