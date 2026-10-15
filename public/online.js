/* =========================================================
   온라인 랭킹 모듈 (Neon Postgres via /api)
   - 서버(http://)로 접속하면 온라인 랭킹
   - index.html 을 직접 열면(file://) 이 브라우저 전용 오프라인 랭킹
   ========================================================= */
const Online = (() => {
  const LOCAL_KEY = 'neonStripLocalBoard';
  const LIMIT = 20;
  const POLL_MS = 8000;
  let mode = 'local';
  let me = null;
  let cb = null;

  async function init(player) {
    me = player;
    if (location.protocol.startsWith('http')) {
      try {
        const r = await fetch('/api/health');
        if (r.ok) mode = 'online';
      } catch (e) {}
    }
    return mode;
  }

  // ----- local -----
  function localMap() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch (e) { return {}; }
  }
  function localList() {
    return Object.entries(localMap())
      .map(([id, v]) => ({ ...v, me: id === me.id }))
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT);
  }

  // ----- online -----
  async function refresh() {
    if (!cb) return;
    if (mode !== 'online') { cb(localList()); return; }
    try {
      const r = await fetch(`/api/leaderboard?me=${encodeURIComponent(me.id)}`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      cb(data.top, null, data.myRank);
    } catch (e) {
      console.error(e);
      cb(null, e);
    }
  }

  /** 최고 기록 제출 (서버가 더 높을 때만 갱신) */
  async function submit(player, score, spins) {
    score = Math.round(score);
    if (mode === 'online') {
      const r = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: player.id, name: player.name, score, spins }),
      });
      if (!r.ok) throw new Error('submit failed: ' + r.status);
    } else {
      const map = localMap();
      const prev = map[player.id];
      map[player.id] = (!prev || prev.score < score)
        ? { name: player.name, score, spins }
        : { ...prev, name: player.name };
      localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
    }
    refresh();
  }

  /** 닉네임 변경 = 기존 최고점으로 재제출 (점수는 안 내려감) */
  function rename(player) { return submit(player, player.best, player.bestSpins || 0); }

  /** TOP 랭킹 구독 (온라인은 주기적 갱신) */
  function subscribe(fn) {
    cb = fn;
    refresh();
    if (mode === 'online') setInterval(refresh, POLL_MS);
  }

  return { init, submit, rename, subscribe, get mode() { return mode; } };
})();
