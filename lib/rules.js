/* =========================================================
   게임 규칙 (서버가 단일 진실 공급원)
   ========================================================= */

export const SYMBOLS = [
  { s: '🍒', w: 30, pay: 10 },
  { s: '🍋', w: 25, pay: 15 },
  { s: '🍊', w: 20, pay: 20 },
  { s: '🔔', w: 12, pay: 40 },
  { s: '⭐', w: 8,  pay: 80 },
  { s: '💎', w: 4,  pay: 200 },
  { s: '7️⃣', w: 2,  pay: 777 },
];
export const CHERRY_PAIR = 2;
export const LINES = [
  { rows: [1, 1, 1], color: '#ffd23f' },
  { rows: [0, 0, 0], color: '#2ff3ff' },
  { rows: [2, 2, 2], color: '#3bff8f' },
  { rows: [0, 1, 2], color: '#ff2fd0' },
  { rows: [2, 1, 0], color: '#ff8a3d' },
];
export const BETS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
export const JACKPOT_SEED = 25000;
export const JACKPOT_RATE = 0.03;

export const ECON = {
  START_MONEY: 1000,
  START_CREDIT: 650,
  CREDIT_MIN: 300,
  CREDIT_MAX: 850,
  // 신용 변화
  CREDIT_BORROW: -5,
  CREDIT_REPAY_ON_TIME: +30,
  CREDIT_REPAY_LATE: +5,
  CREDIT_OVERDUE: -40,
  CREDIT_SEIZED: -10,
  CREDIT_BANKRUPT: -80,
  // 연체
  OVERDUE_RATE_MULT: 2,          // 연체 시 이자 배수
  OWED_CAP_MULT: 10,             // 빚은 원금의 10배를 넘지 않음
  SEIZE_FLOOR: 100,              // 압류 후에도 남겨주는 최소 잔고
  SEIZE_RATIO: 0.5,              // 1회 압류 비율 (잔고/당첨금의 50%)
  NPC_BLACKLIST_HOURS: 24,       // NPC 빚을 24시간 넘게 연체하면 블랙리스트
  // 파산
  BANKRUPT_COOLDOWN_MIN: 60,
  // 유저 대출
  OFFER_MIN: 100,
  OFFER_MAX: 1_000_000,
  RATE_MAX_PCT: 20,              // 시간당 최대 20%
  TERM_MIN_H: 1,
  TERM_MAX_H: 72,
  MAX_OPEN_LEND: 5,
  MAX_OPEN_BORROW: 3,
  MAX_ACTIVE_P2P_BORROW: 5,
  NEWBIE_HOURS: 24,              // 가입 24시간 이내 = 신규
  NEWBIE_P2P_BORROW_CAP: 2000,   // 신규 계정의 유저 대출 총액 한도
};

// 이자: 시간당 비율 (0.01 = 1%/h)
export const NPC_LENDERS = [
  { id: 'rose',  name: '로즈 할머니',       ava: '👵', from: 'Pasadena',     rate: 0.005, term: 72, cap: 500,   minCredit: 550, tag: 'nice',  quote: '아이고 얘야, 밥은 먹고 다니니? 꼭 갚으렴.' },
  { id: 'jay',   name: '제이 (할리우드 PD)', ava: '🎬', from: 'Hollywood',    rate: 0.01,  term: 48, cap: 1500,  minCredit: 600, tag: '',      quote: '자네 스토리 좋아. 투자하지. 대신 엔딩은 해피엔딩이어야 해.' },
  { id: 'chad',  name: '채드 (산타모니카)',  ava: '🏄', from: 'Santa Monica', rate: 0.015, term: 36, cap: 3000,  minCredit: 500, tag: '',      quote: '브로~ 코인으로 번 돈이야. 바이브만 좋으면 OK 🤙' },
  { id: 'lulu',  name: '럭키 루',            ava: '🍀', from: 'Fremont St.',  rate: 0.025, term: 24, cap: 5000,  minCredit: 420, tag: '',      quote: '운은 빌려줄 수 없지만 돈은 빌려줄 수 있지.' },
  { id: 'vinny', name: '비니 "더 샤크"',     ava: '🦈', from: 'The Strip',    rate: 0.05,  term: 12, cap: 15000, minCredit: 0,   tag: 'shark', quote: '신용? 그런 건 필요 없어. 기한만 지키면 돼… 지키면.' },
  { id: 'don',   name: '돈 코를레오네 Jr.',  ava: '🕴️', from: '???',          rate: 0.10,  term: 6,  cap: 60000, minCredit: 0,   tag: 'shark', quote: '거절할 수 없는 제안을 하지.' },
];
export const npcById = id => NPC_LENDERS.find(n => n.id === id);

export const clampCredit = c => Math.max(ECON.CREDIT_MIN, Math.min(ECON.CREDIT_MAX, Math.round(c)));
