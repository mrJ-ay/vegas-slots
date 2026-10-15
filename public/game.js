/* =========================================================
   NEON STRIP — 클라이언트
   - 로그인: ONEID SSO (PKCE)
   - 잔고/스핀/대출은 전부 서버가 계산, 화면은 연출만
   ========================================================= */

// ---------- 유틸 ----------
const $ = id => document.getElementById(id);
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
function money(n) {
  const neg = n < 0; n = Math.abs(Math.round(n || 0));
  return (neg ? '-$' : '$') + n.toLocaleString('en-US');
}
const pct = r => (Number(r) * 100).toFixed(1) + '%';
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtLeft(ms) {
  const late = ms < 0; ms = Math.abs(ms);
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  const t = h ? `${h}시간 ${m}분` : `${m}분`;
  return late ? `연체 ${t}` : `${t} 남음`;
}

// ---------- 상태 ----------
let CFG = null;      // 서버 설정 (심볼, 배당, NPC 등)
let S = null;        // 내 상태 (/api/state)
let token = null;
let ws = null;
let spinning = false;
let pendingRefresh = false;
let currentGrid = null;
let soundOn = true;
let market = [];
let marketKind = 'lend';
let feedItems = [];
let betIdx = Number(localStorage.getItem('ns_betIdx') || 0);

// ---------- 사운드 ----------
let actx;
function tone(freq, dur = 0.1, type = 'square', vol = 0.05, delay = 0) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    const t = actx.currentTime + delay;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (e) {}
}
const sfx = {
  stop: () => tone(180, 0.08, 'square', 0.06),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.15, 'triangle', 0.08, i * 0.09)),
  big: () => [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.2, 'square', 0.07, i * 0.1)),
  lose: () => tone(110, 0.25, 'sawtooth', 0.04),
  cash: () => [880, 1320].forEach((f, i) => tone(f, 0.1, 'sine', 0.08, i * 0.07)),
  bad: () => [300, 200, 120].forEach((f, i) => tone(f, 0.25, 'sawtooth', 0.06, i * 0.18)),
};

// =========================================================
// ONEID 로그인 (PKCE)
// =========================================================
const AUTH_KEY = 'ns_auth';
const PKCE_KEY = 'ns_pkce';
const redirectUri = () => location.origin + '/';
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function startLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  location.assign(`${CFG.oneidUrl}/login.html?` + new URLSearchParams({
    client_id: CFG.clientId, redirect_uri: redirectUri(), code_challenge: challenge, state,
  }));
}

async function handleCallback() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null');
  sessionStorage.removeItem(PKCE_KEY);
  history.replaceState(null, '', '/');
  if (!saved || saved.state !== p.get('state')) throw new Error('로그인 검증에 실패했습니다. 다시 시도해 주세요.');
  const r = await fetch(`${CFG.oneidUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CFG.clientId, redirect_uri: redirectUri(), code, code_verifier: saved.verifier }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || 'ONEID 로그인에 실패했습니다.');
  localStorage.setItem(AUTH_KEY, JSON.stringify({ token: d.access_token, exp: Date.now() + (d.expires_in || 7200) * 1000 }));
}

function loadAuth() {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY));
    if (a && a.exp - 60_000 > Date.now()) return a.token;
  } catch (e) {}
  return null;
}

function showGate(msg = '') {
  $('gate').classList.add('show');
  $('gateMsg').textContent = msg;
  $('autoSpin').checked = false;
}
function logout(msg) {
  localStorage.removeItem(AUTH_KEY);
  token = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  showGate(msg);
}

// =========================================================
// API
// =========================================================
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) { logout(d.error || '다시 로그인해 주세요.'); throw new Error(d.error || 'unauthorized'); }
  if (!r.ok) throw new Error(d.error || '요청을 처리하지 못했습니다.');
  return d;
}

async function loadState() {
  if (spinning) { pendingRefresh = true; return; }
  pendingRefresh = false;
  S = await api('/api/state');
  renderAll();
}
async function loadMarket() { market = await api('/api/market'); renderMarket(); }
async function loadBoard() { const d = await api('/api/leaderboard'); renderBoard(d.top); }

// =========================================================
// 실시간
// =========================================================
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') { feedItems = m.feed; renderFeed(); setOnline(m.online); }
    else if (m.type === 'feed') { feedItems.unshift(m.item); feedItems.length = Math.min(feedItems.length, 50); renderFeed(); }
    else if (m.type === 'notify') { toast(m.text, m.level); m.level === 'bad' ? sfx.bad() : sfx.cash(); }
    else if (m.type === 'refresh') loadState().catch(console.error);
    else if (m.type === 'market') loadMarket().catch(console.error);
    else if (m.type === 'board') renderBoard(m.top);
    else if (m.type === 'online') setOnline(m.count);
  };
  ws.onclose = e => {
    ws = null;
    if (e.code === 4001) { logout('로그인이 만료되었습니다.'); return; }
    if (token) setTimeout(connectWS, 3000);
  };
}
const setOnline = n => { $('onlineCount').textContent = n; };

// =========================================================
// 릴
// =========================================================
const reelEls = [...document.querySelectorAll('.reel')];
const symH = () => reelEls[0].clientHeight / 3;
const randomSym = () => CFG.symbols[rand(0, CFG.symbols.length - 1)].s;

function renderStrip(i, symbols) {
  const strip = reelEls[i].querySelector('.strip');
  strip.style.transition = 'none';
  strip.style.transform = 'translateY(0)';
  strip.innerHTML = symbols.map(s => `<div class="sym">${s}</div>`).join('');
  [...strip.children].forEach(c => c.style.height = symH() + 'px');
}
function initReels() {
  currentGrid = [0, 1, 2].map(() => [randomSym(), randomSym(), randomSym()]);
  currentGrid.forEach((col, i) => renderStrip(i, col));
}
function animateReel(i, result, duration) {
  return new Promise(resolve => {
    const fillers = Array.from({ length: 18 + i * 6 }, randomSym);
    const all = [...result, ...fillers, ...currentGrid[i]];
    renderStrip(i, all);
    const strip = reelEls[i].querySelector('.strip');
    strip.style.transform = `translateY(${-(all.length - 3) * symH()}px)`;
    strip.offsetHeight;
    strip.style.transition = `transform ${duration}ms cubic-bezier(.15,.75,.25,1.05)`;
    strip.style.transform = 'translateY(0)';
    setTimeout(() => { renderStrip(i, result); sfx.stop(); resolve(); }, duration);
  });
}
function showWins(wins) {
  const svg = $('lines');
  svg.innerHTML = '';
  wins.forEach(w => {
    const line = CFG.lines[w.li];
    w.cells.forEach(c => reelEls[c].querySelector('.strip').children[line.rows[c]]?.classList.add('win'));
    const pts = line.rows.map((r, c) => `${50 + c * 100},${50 + r * 100}`).join(' ');
    svg.innerHTML += `<polyline points="${pts}" stroke="${line.color}" style="color:${line.color}" />`;
  });
  $('marquee').classList.add('party');
  setTimeout(() => $('marquee').classList.remove('party'), 2000);
}

// =========================================================
// 스핀
// =========================================================
const LOSE_LINES = [
  '하우스는 언제나 이긴다… 🏛️', '다음 판엔 터질 거야 (아마도)', '라스베가스에서 일어난 일은 라스베가스에…',
  '할리우드 엔딩은 아직이야 🎬', '꽝! 빌려준 사람들이 웃고 있다 🦈', '아깝다! (아깝지 않았음)', '선셋대로에 해가 진다 🌅',
];
const bet = () => CFG.bets[betIdx];

async function spin() {
  if (spinning || !S) return;
  const b = bet();
  if (S.me.balance < b) {
    flash('잔고 부족! 배팅을 낮추거나 돈을 빌려라 💸', 'bad');
    $('autoSpin').checked = false; shake();
    return;
  }
  spinning = true;
  setControls(false);
  $('lines').innerHTML = '';
  flash('돌아간다…', '');
  $('balance').textContent = money(S.me.balance - b);

  let res;
  try {
    res = await api('/api/spin', { method: 'POST', body: { bet: b } });
  } catch (e) {
    flash(e.message, 'bad');
    spinning = false; setControls(true); $('autoSpin').checked = false;
    renderWallet();
    return;
  }

  await Promise.all(res.grid.map((col, i) => animateReel(i, col, 900 + i * 350)));
  currentGrid = res.grid;

  S.me.balance = res.balance;
  S.me.spins++;
  S.jackpot = res.jackpot;
  if (res.win > 0) {
    showWins(res.wins);
    const ratio = res.win / b;
    if (res.jackpotWon) { flash(`🎰 JACKPOT!!! ${money(res.win)} 🎰`, 'win'); bigWin('JACKPOT'); sfx.big(); coins(80); }
    else if (ratio >= 15) { flash(`BIG WIN! +${money(res.win)}`, 'win'); bigWin(ratio >= 50 ? 'MEGA WIN' : 'BIG WIN'); sfx.big(); coins(ratio >= 50 ? 60 : 30); }
    else { flash(`WIN +${money(res.win)}`, 'win'); sfx.win(); }
    if (res.seized > 0) { toast(`🥊 연체 중이라 당첨금 중 ${money(res.seized)} 자동 압류`, 'bad'); pendingRefresh = true; }
  } else {
    flash(LOSE_LINES[rand(0, LOSE_LINES.length - 1)], 'lose'); sfx.lose();
  }

  spinning = false;
  setControls(true);
  if (pendingRefresh) await loadState().catch(console.error); else renderAll();

  if ($('autoSpin').checked) {
    if (S.me.balance >= bet()) setTimeout(spin, 500);
    else { $('autoSpin').checked = false; flash('잔고 부족으로 자동 스핀 중지', 'bad'); }
  }
}

// =========================================================
// 렌더
// =========================================================
function renderAll() {
  if (!S) return;
  renderWallet(); renderBorrowed(); renderLent(); renderMyOffers(); renderNpc(); renderMarket();
}

function renderWallet() {
  const m = S.me;
  const net = m.balance + S.escrow + S.receivable - S.debt;
  $('meName').textContent = m.name;
  $('balance').textContent = money(m.balance);
  $('totalDebt').textContent = money(S.debt);
  $('receivable').textContent = money(S.receivable);
  $('escrow').textContent = money(S.escrow);
  $('netWorth').textContent = money(net);
  $('netWorth').style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
  $('credit').textContent = m.credit;
  $('credit').style.color = m.credit >= 650 ? 'var(--green)' : m.credit >= 500 ? 'var(--gold)' : 'var(--red)';
  $('creditFill').style.width = ((m.credit - 300) / 550 * 100) + '%';
  $('myRankTop').textContent = S.myRank ? `${S.myRank}위` : '-';
  $('spinCount').textContent = `${m.spins.toLocaleString()} / ${m.bankruptcies}`;
  $('jackpot').textContent = money(S.jackpot);
  $('bet').textContent = money(bet());
  setOnline(S.online);

  const nb = $('newbieNote');
  nb.hidden = !m.newbie;
  nb.textContent = `🐣 신규 계정: 가입 ${CFG.econ.newbieHours}시간 동안 유저 대출은 총 ${money(CFG.econ.newbieCap)}까지만 빌릴 수 있습니다.`;

  const bb = $('bankruptBtn');
  bb.hidden = m.balance >= CFG.bets[0];
  bb.disabled = m.bankruptCooldownMs > 0;
  bb.textContent = m.bankruptCooldownMs > 0
    ? `💀 파산 신청 대기 (${Math.ceil(m.bankruptCooldownMs / 60000)}분)`
    : '💀 파산 신청 ($1,000 재시작, 빚은 유지)';
}

function loanCard(l, side) {
  const left = new Date(l.dueAt).getTime() - Date.now();
  const rate = l.overdue ? pct(l.rate * 2) : pct(l.rate);
  return `<div class="loan ${l.overdue ? 'overdue' : ''}">
    <div class="row"><span class="who">${esc(l.who)}</span><span class="owed">${money(l.owed)}</span></div>
    <div class="meta">원금 ${money(l.principal)} · 시간당 ${rate} · <span data-due="${esc(l.dueAt)}">${fmtLeft(left)}</span>
      ${l.seized ? ` · 압류 ${money(l.seized)}` : ''}</div>
    ${side === 'borrowed' ? `<div class="btns">
      <button class="btn ghost" data-repay="${l.id}" data-half="1">절반 상환</button>
      <button class="btn" data-repay="${l.id}">전액 상환</button></div>`
    : l.overdue ? `<div class="meta" style="color:#ff3b5c">🚨 연체 중 — 상대가 돈을 따면 자동 회수</div>` : ''}
  </div>`;
}
function renderBorrowed() {
  $('borrowedList').innerHTML = S.borrowed.length
    ? S.borrowed.map(l => loanCard(l, 'borrowed')).join('')
    : '<div class="empty">빚 없음. 아직은 깨끗하다 😇</div>';
}
function renderLent() {
  $('lentList').innerHTML = S.lent.length
    ? S.lent.map(l => loanCard(l, 'lent')).join('')
    : '<div class="empty">빌려준 돈 없음</div>';
}
function renderMyOffers() {
  $('myOffers').innerHTML = S.myOffers.length
    ? S.myOffers.map(o => `<div class="offer mine">
        <div class="row"><span class="who">${o.kind === 'lend' ? '💼 빌려줄게요' : '🙏 구해요'}</span><span class="amt">${money(o.amount)}</span></div>
        <div class="meta">시간당 ${pct(o.rate)} · ${o.termHours}시간${o.kind === 'lend' ? ` · 신용 ${o.minCredit}+` : ''}</div>
        <button class="btn ghost" data-cancel="${o.id}">글 내리기${o.kind === 'lend' ? ' (돈 돌려받기)' : ''}</button>
      </div>`).join('')
    : '<div class="empty">올린 글 없음</div>';
}

function renderMarket() {
  if (!S) return;
  const list = market.filter(o => o.kind === marketKind);
  $('marketList').innerHTML = list.length ? list.map(o => {
    const total = o.amount * Math.pow(1 + Number(o.rate), o.termHours);
    const badges = [
      `<span class="badge ${o.ownerCredit >= 650 ? 'green' : o.ownerCredit >= 500 ? 'gold' : 'red'}">신용 ${o.ownerCredit}</span>`,
      o.newbie ? '<span class="badge gold">🐣 신규</span>' : '',
      o.defaulter ? '<span class="badge red">🚨 연체자</span>' : '',
    ].join('');
    let action;
    if (o.mine) action = `<button class="btn ghost" data-cancel="${o.id}">내 글 내리기</button>`;
    else if (o.kind === 'lend') {
      const blocked = S.me.credit < o.minCredit;
      action = `<button class="btn" data-accept="${o.id}" ${blocked ? 'disabled' : ''}>${blocked ? `신용 ${o.minCredit}+ 필요` : '빌리기'}</button>`;
    } else {
      const blocked = S.me.balance < o.amount;
      action = `<button class="btn" data-accept="${o.id}" ${blocked ? 'disabled' : ''}>${blocked ? '잔고 부족' : '빌려주기'}</button>`;
    }
    return `<div class="offer ${o.mine ? 'mine' : ''}">
      <div class="row"><span class="who">${esc(o.owner)}${badges}</span><span class="amt">${money(o.amount)}</span></div>
      <div class="meta">시간당 <b>${pct(o.rate)}</b> · ${o.termHours}시간 · 기한 내 상환 ${money(total)}${o.kind === 'lend' && o.minCredit > 300 ? ` · 신용 ${o.minCredit}+` : ''}</div>
      ${o.note ? `<div class="note">"${esc(o.note)}"</div>` : ''}
      <div class="row" style="justify-content:flex-end">${action}</div>
    </div>`;
  }).join('') : `<div class="empty">${marketKind === 'lend' ? '빌려주겠다는 글이 아직 없습니다' : '구한다는 글이 아직 없습니다'}</div>`;
}

function renderNpc() {
  $('lenderList').innerHTML = CFG.npc.map(d => {
    const st = S.npc.find(n => n.id === d.id) || { ok: false, why: '-' };
    const tag = d.tag === 'shark' ? '<span class="tag shark">사채</span>' : d.tag === 'nice' ? '<span class="tag nice">착함</span>' : '';
    return `<div class="lender ${st.ok ? '' : 'locked'}">
      <div class="ava">${d.ava}</div>
      <div class="info">
        <div class="name">${esc(d.name)}${tag}</div>
        <small>📍${esc(d.from)} · 시간당 ${pct(d.rate)} · ${d.term}시간</small><br>
        <small>${st.ok ? `최대 <b style="color:#3bff8f">${money(st.max)}</b>` : esc(st.why)}</small>
      </div>
      <button class="btn" data-npc="${d.id}" ${st.ok ? '' : 'disabled'}>빌리기</button>
    </div>`;
  }).join('');
}

function renderBoard(top) {
  const myId = S?.me.id;
  $('onlineBoard').innerHTML = top?.length ? top.map(p => `<li class="${p.id === myId ? 'me' : ''}">
      <span class="nm">${esc(p.name)}</span>
      ${p.defaulter ? '<span class="badge red">🚨 연체</span>' : ''}
      ${p.bankruptcies ? `<span class="badge">💀${p.bankruptcies}</span>` : ''}
      <span class="sc ${p.net < 0 ? 'neg' : ''}">${money(p.net)}</span></li>`).join('')
    : '<li class="empty">아직 아무도 없습니다</li>';
}

function renderFeed() {
  $('feed').innerHTML = feedItems.map(f => `<li class="${esc(f.level)}">${esc(f.text)}</li>`).join('');
}
function renderPaytable() {
  $('paytable').innerHTML = CFG.symbols.slice().reverse().map(s =>
    `<div><span>${s.s}${s.s}${s.s}</span><b>×${s.pay}</b></div>`).join('') +
    `<div><span>🍒🍒 ❔</span><b>×${CFG.cherryPair}</b></div>` +
    `<div><span>7️⃣7️⃣7️⃣ 가운데줄</span><b>+잭팟</b></div>`;
}
function refreshTimes() {
  document.querySelectorAll('[data-due]').forEach(el => { el.textContent = fmtLeft(new Date(el.dataset.due).getTime() - Date.now()); });
}

// ---------- UI 헬퍼 ----------
function flash(text, cls) { const m = $('message'); m.textContent = text; m.className = 'message ' + (cls || ''); }
function setControls(on) { ['spinBtn', 'betUp', 'betDown', 'maxBet'].forEach(id => $(id).disabled = !on); }
function shake() { const m = document.querySelector('.machine'); m.classList.remove('shake'); m.offsetWidth; m.classList.add('shake'); }
function bigWin(text) { const b = $('bigWin'); b.textContent = text; b.classList.remove('show'); b.offsetWidth; b.classList.add('show'); }
function coins(n) {
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'coin'; c.textContent = ['💰', '🪙', '💵', '💎'][rand(0, 3)];
    c.style.left = Math.random() * 100 + 'vw';
    c.style.animationDuration = (1.5 + Math.random() * 2) + 's';
    c.style.animationDelay = Math.random() * 0.8 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4500);
  }
}
function toast(text, level = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + level;
  t.textContent = text;
  $('toasts').prepend(t);
  setTimeout(() => t.remove(), 6000);
}
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) { toast(okMsg, 'win'); sfx.cash(); } await loadState(); }
  catch (e) { toast(e.message, 'bad'); shake(); }
}

// =========================================================
// 모달: NPC 대출
// =========================================================
let modalNpc = null;
function openNpcModal(id) {
  const d = CFG.npc.find(n => n.id === id), st = S.npc.find(n => n.id === id);
  if (!st?.ok) return;
  modalNpc = d;
  $('mLender').textContent = `${d.ava} ${d.name}`;
  $('mQuote').textContent = `"${d.quote}"`;
  $('mTerms').innerHTML = `이자: <b>시간당 ${pct(d.rate)}</b> 복리 (실제 시간 기준)<br>
    기한: <b>${d.term}시간</b> · 연체하면 이자 2배 + 돈을 딸 때마다 자동 압류 · 24시간 넘게 연체하면 블랙리스트<br>
    한도: <b>${money(st.max)}</b> (신용점수 ${S.me.credit} 반영)`;
  const r = $('mAmount');
  r.min = 10; r.max = st.max; r.step = 10; r.value = Math.max(10, Math.floor(st.max / 2 / 10) * 10);
  updateNpcModal();
  $('loanModal').classList.add('show');
}
function updateNpcModal() {
  const amt = +$('mAmount').value;
  $('mAmountShow').textContent = money(amt);
  $('mRepayShow').textContent = money(amt * Math.pow(1 + modalNpc.rate, modalNpc.term));
}

// =========================================================
// 모달: 게시글 작성
// =========================================================
let offerKind = 'lend';
function openOfferModal(kind) {
  offerKind = kind;
  $('oTitle').textContent = kind === 'lend' ? '💼 빌려주기 글 올리기' : '🙏 구해요 글 올리기';
  $('oMinCreditWrap').hidden = kind !== 'lend';
  $('oHint').textContent = kind === 'lend'
    ? '글을 올리면 그 금액이 잔고에서 미리 빠져서 묶입니다. 글을 내리면 돌려받아요.'
    : '누군가 수락하면 바로 잔고에 들어옵니다. 기한 안에 갚지 못하면 연체자로 표시되고 자동 압류됩니다.';
  updateOfferPreview();
  $('offerModal').classList.add('show');
}
function updateOfferPreview() {
  const a = +$('oAmount').value || 0, r = (+$('oRate').value || 0) / 100, t = +$('oTerm').value || 0;
  $('oPreview').textContent = money(a * Math.pow(1 + r, t));
}

// =========================================================
// 이벤트
// =========================================================
$('loginBtn').onclick = () => startLogin().catch(e => { $('gateMsg').textContent = e.message; });
$('logoutBtn').onclick = () => logout('로그아웃했습니다.');
$('spinBtn').onclick = spin;
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !document.querySelector('.modal.show, .gate.show') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault(); spin();
  }
});
const setBet = i => { betIdx = Math.max(0, Math.min(CFG.bets.length - 1, i)); localStorage.setItem('ns_betIdx', betIdx); $('bet').textContent = money(bet()); };
$('betUp').onclick = () => setBet(betIdx + 1);
$('betDown').onclick = () => setBet(betIdx - 1);
$('maxBet').onclick = () => { let i = CFG.bets.length - 1; while (i > 0 && CFG.bets[i] > S.me.balance) i--; setBet(i); };
$('autoSpin').onchange = e => { if (e.target.checked && !spinning) spin(); };
$('soundBtn').onclick = () => { soundOn = !soundOn; $('soundBtn').textContent = soundOn ? '🔊' : '🔇'; };

$('bankruptBtn').onclick = () => {
  if (!confirm('파산 신청할까요?\n잔고가 $1,000으로 재시작되지만 빚은 그대로 남고, 신용점수가 크게 떨어집니다.')) return;
  act(() => api('/api/bankrupt', { method: 'POST' }), '💀 파산 신청 완료. $1,000로 재기 도전!');
};

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  $('tab-p2p').hidden = t.dataset.tab !== 'p2p';
  $('tab-npc').hidden = t.dataset.tab !== 'npc';
});
document.querySelectorAll('.subtab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.subtab').forEach(x => x.classList.toggle('active', x === t));
  marketKind = t.dataset.kind; renderMarket();
});
$('newLendBtn').onclick = () => openOfferModal('lend');
$('newBorrowBtn').onclick = () => openOfferModal('borrow');
['oAmount', 'oRate', 'oTerm'].forEach(id => $(id).oninput = updateOfferPreview);
$('oConfirm').onclick = () => {
  const body = {
    kind: offerKind, amount: +$('oAmount').value, ratePct: +$('oRate').value,
    termHours: +$('oTerm').value, minCredit: +$('oMinCredit').value, note: $('oNote').value,
  };
  act(async () => { await api('/api/offers', { method: 'POST', body }); $('offerModal').classList.remove('show'); $('oNote').value = ''; },
    '📌 글을 올렸습니다');
};

$('mAmount').oninput = updateNpcModal;
$('mConfirm').onclick = () => {
  const amount = +$('mAmount').value, d = modalNpc;
  $('loanModal').classList.remove('show');
  act(() => api(`/api/npc/${d.id}/borrow`, { method: 'POST', body: { amount } }), `🤝 ${d.name}에게 ${money(amount)} 빌림`);
};
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.remove('show'));

// 목록 버튼들 (이벤트 위임)
document.body.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  if (t.dataset.npc) openNpcModal(t.dataset.npc);
  else if (t.dataset.repay) {
    const l = S.borrowed.find(x => x.id === +t.dataset.repay);
    const amount = t.dataset.half ? Math.ceil(l.owed / 2) : null;
    act(() => api(`/api/loans/${l.id}/repay`, { method: 'POST', body: { amount } }), '💵 상환 완료');
  }
  else if (t.dataset.cancel) act(() => api(`/api/offers/${t.dataset.cancel}/cancel`, { method: 'POST' }), '글을 내렸습니다');
  else if (t.dataset.accept) {
    const o = market.find(x => x.id === +t.dataset.accept);
    const total = money(o.amount * Math.pow(1 + Number(o.rate), o.termHours));
    const msg = o.kind === 'lend'
      ? `${o.owner}님에게 ${money(o.amount)}을 빌립니다.\n시간당 ${pct(o.rate)}, ${o.termHours}시간 안에 약 ${total}을 갚아야 합니다.\n연체하면 이자 2배 + 자동 압류. 진행할까요?`
      : `${o.owner}님에게 ${money(o.amount)}을 빌려줍니다.\n${o.termHours}시간 뒤 약 ${total}을 돌려받습니다.\n(상대 신용 ${o.ownerCredit}${o.defaulter ? ', 🚨 현재 연체 중' : ''}) 진행할까요?`;
    if (confirm(msg)) act(() => api(`/api/offers/${o.id}/accept`, { method: 'POST' }), '🤝 거래 성사!');
  }
});

window.addEventListener('resize', () => currentGrid && currentGrid.forEach((c, i) => renderStrip(i, c)));

// =========================================================
// 시작
// =========================================================
async function boot() {
  $('gate').classList.remove('show');
  await loadState();
  await Promise.all([loadMarket(), loadBoard()]);
  connectWS();
}

(async function init() {
  try {
    CFG = await (await fetch('/api/config')).json();
  } catch (e) {
    showGate('게임 서버에 연결할 수 없습니다. (index.html을 직접 열지 말고 서버 주소로 접속하세요)');
    $('loginBtn').disabled = true;
    return;
  }
  renderPaytable();
  initReels();
  setBet(betIdx);
  try { await handleCallback(); } catch (e) { showGate(e.message); return; }
  token = loadAuth();
  if (!token) { showGate(); return; }
  try { await boot(); } catch (e) { if (token) showGate(e.message); }
  setInterval(() => { if (token && !document.hidden) loadState().catch(() => {}); }, 60_000);
  setInterval(refreshTimes, 30_000);
})();
