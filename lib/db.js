/* =========================================================
   DB (Neon Postgres via node-postgres Pool)
   ========================================================= */
import pg from 'pg';
import { ECON, JACKPOT_SEED } from './rules.js';

// BIGINT / NUMERIC 를 JS number 로
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1700, v => parseFloat(v));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});
pool.on('error', e => console.error('pg pool error', e));

const RETRY_CODES = new Set(['40P01', '40001']); // deadlock, serialization

/** 트랜잭션 실행. 데드락이면 최대 3번 재시도 */
export async function tx(fn) {
  for (let attempt = 1; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (RETRY_CODES.has(e.code) && attempt < 3) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}

export const q = (text, params) => pool.query(text, params);

export async function initSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS ns_players (
      id               TEXT PRIMARY KEY,               -- ONEID user id
      name             TEXT NOT NULL,
      balance          BIGINT NOT NULL DEFAULT ${ECON.START_MONEY} CHECK (balance >= 0),
      credit           INTEGER NOT NULL DEFAULT ${ECON.START_CREDIT},
      spins            INTEGER NOT NULL DEFAULT 0,
      bankruptcies     INTEGER NOT NULL DEFAULT 0,
      last_bankrupt_at TIMESTAMPTZ,
      npc_blacklist    TEXT[] NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ns_offers (
      id          SERIAL PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('lend', 'borrow')),
      owner_id    TEXT NOT NULL REFERENCES ns_players(id),
      amount      BIGINT NOT NULL CHECK (amount > 0),
      rate        NUMERIC(8,5) NOT NULL CHECK (rate >= 0),
      term_hours  INTEGER NOT NULL,
      min_credit  INTEGER NOT NULL DEFAULT 300,
      note        TEXT,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'taken', 'cancelled')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ns_offers_open_idx ON ns_offers (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS ns_loans (
      id               SERIAL PRIMARY KEY,
      lender_id        TEXT NOT NULL,                  -- 유저 id 또는 'npc:<id>'
      borrower_id      TEXT NOT NULL REFERENCES ns_players(id),
      principal        BIGINT NOT NULL,
      rate             NUMERIC(8,5) NOT NULL,          -- 시간당
      owed_base        DOUBLE PRECISION NOT NULL,      -- accrued_at 시점의 빚
      accrued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      due_at           TIMESTAMPTZ NOT NULL,
      repaid           BIGINT NOT NULL DEFAULT 0,
      seized           BIGINT NOT NULL DEFAULT 0,
      overdue_notified BOOLEAN NOT NULL DEFAULT false,
      status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid')),
      closed_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ns_loans_borrower_idx ON ns_loans (borrower_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS ns_loans_lender_idx   ON ns_loans (lender_id)   WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS ns_ledger (
      id            BIGSERIAL PRIMARY KEY,
      player_id     TEXT NOT NULL,
      delta         BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      reason        TEXT NOT NULL,
      ref           TEXT,
      at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ns_ledger_player_idx ON ns_ledger (player_id, at DESC);

    CREATE TABLE IF NOT EXISTS ns_meta (
      key   TEXT PRIMARY KEY,
      value BIGINT NOT NULL
    );
    INSERT INTO ns_meta (key, value) VALUES ('jackpot', ${JACKPOT_SEED}) ON CONFLICT DO NOTHING;
  `);
}

/** 플레이어 행 잠금 (데드락 방지를 위해 id 순서대로) */
export async function lockPlayers(c, ids) {
  const { rows } = await c.query(
    'SELECT * FROM ns_players WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
  return Object.fromEntries(rows.map(r => [r.id, r]));
}

/** 잔고 변경 + 원장 기록 */
export async function adjust(c, playerId, delta, reason, ref = null) {
  delta = Math.round(delta);
  const { rows } = await c.query(
    'UPDATE ns_players SET balance = balance + $2 WHERE id = $1 RETURNING balance', [playerId, delta]);
  if (!rows.length) throw new Error('player not found: ' + playerId);
  await c.query(
    'INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref) VALUES ($1, $2, $3, $4, $5)',
    [playerId, delta, rows[0].balance, reason, ref]);
  return rows[0].balance;
}

export async function addCredit(c, playerId, diff) {
  await c.query(
    `UPDATE ns_players SET credit = LEAST(${ECON.CREDIT_MAX}, GREATEST(${ECON.CREDIT_MIN}, credit + $2)) WHERE id = $1`,
    [playerId, Math.round(diff)]);
}
