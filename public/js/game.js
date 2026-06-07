/* ─── game.js ─────────────────────────────────────────────────────────────── */
const socket = io({ transports: ['websocket', 'polling'] });

// ── DOM ───────────────────────────────────────────────────────────────────────
const lobby        = document.getElementById('lobby');
const gameWrap     = document.getElementById('game-wrap');
const canvas       = document.getElementById('canvas');
const ctx          = canvas.getContext('2d');
const joinBtn      = document.getElementById('join-btn');
const roomInput    = document.getElementById('room-input');
const lobbyStatus  = document.getElementById('lobby-status');
const hudCenter    = document.getElementById('hud-center');
const chargeFill   = document.getElementById('charge-bar-fill');
const chargePct    = document.getElementById('charge-pct');
const overlay      = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlaySub   = document.getElementById('overlay-sub');
const overlayWins  = document.getElementById('overlay-wins');
const overlayBtn   = document.getElementById('overlay-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let myId = null, mySlot = null;
let platforms = [];
let players = [];
let javelins = [];
let MAP_W = 1200, MAP_H = 600;
let mouseX = 600, mouseY = 300;
let keys = { left: false, right: false };
let charging = false;
let localChargeTime = 0;  // client-side charge accumulator for smooth bar
let localChargeStart = 0;
const CHARGE_MAX = 1.8;
let roundNum = 0;
let gameState = 'lobby';
let readyPressed = false;

let scale = 1;

// ── Canvas resize ─────────────────────────────────────────────────────────────
function resizeCanvas() {
  const maxW = window.innerWidth - 16;
  const maxH = window.innerHeight - 100;
  scale = Math.min(maxW / MAP_W, maxH / MAP_H, 1);
  canvas.width  = MAP_W;
  canvas.height = MAP_H;
  canvas.style.width  = Math.floor(MAP_W * scale) + 'px';
  canvas.style.height = Math.floor(MAP_H * scale) + 'px';
}
window.addEventListener('resize', resizeCanvas);

// ── Mouse helpers ─────────────────────────────────────────────────────────────
function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / scale,
    y: (e.clientY - rect.top)  / scale
  };
}
function getAimAngle() {
  const me = players.find(p => p.id === myId);
  if (!me) return 0;
  return Math.atan2(mouseY - (me.y + 20), mouseX - (me.x + 14));
}

// ── Input ─────────────────────────────────────────────────────────────────────
let lastLeft = false, lastRight = false;

function sendMovement() {
  socket.emit('input', { keys: { ...keys }, aimAngle: getAimAngle() });
}

document.addEventListener('keydown', e => {
  if (gameState !== 'playing') return;
  const k = e.key.toLowerCase();

  if (k === 'a' || k === 'arrowleft')  keys.left  = true;
  if (k === 'd' || k === 'arrowright') keys.right = true;

  if (k === 'a' || k === 'd' || k === 'arrowleft' || k === 'arrowright') sendMovement();

  if ((k === 'w' || k === ' ' || k === 'arrowup')) {
    e.preventDefault();
    socket.emit('jump');
  }
  if (k === 'f' || k === 'shift') socket.emit('roll');
});

document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft')  keys.left  = false;
  if (k === 'd' || k === 'arrowright') keys.right = false;
  if (k === 'a' || k === 'd' || k === 'arrowleft' || k === 'arrowright') {
    if (gameState === 'playing') sendMovement();
  }
});

canvas.addEventListener('mousemove', e => {
  const p = canvasPos(e);
  mouseX = p.x; mouseY = p.y;
  if (gameState === 'playing') {
    socket.emit('input', { aimAngle: getAimAngle() });
  }
});

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0 || gameState !== 'playing') return;
  const me = players.find(p => p.id === myId);
  if (!me || me.dead || me.javelins <= 0) return;
  charging = true;
  localChargeTime = 0;
  localChargeStart = performance.now();
  socket.emit('startCharge');
});

canvas.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  if (charging && gameState === 'playing') {
    socket.emit('releaseThrow', { aimAngle: getAimAngle() });
  }
  charging = false;
  localChargeTime = 0;
});

// Cancel charge on right click or focus loss
canvas.addEventListener('contextmenu', e => { e.preventDefault(); cancelCharge(); });
window.addEventListener('blur', cancelCharge);
function cancelCharge() {
  if (charging) { charging = false; localChargeTime = 0; socket.emit('cancelCharge'); }
}

window.addEventListener('keydown', e => {
  if (e.key === ' ') e.preventDefault();
}, { passive: false });

// ── Lobby ─────────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  let id = roomInput.value.trim().toUpperCase();
  if (!id) id = randomRoomId();
  roomInput.value = id;
  lobbyStatus.textContent = 'Connecting…';
  joinBtn.disabled = true;
  socket.emit('joinRoom', { roomId: id });
});
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

function randomRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('connect', () => {
  lobbyStatus.textContent = '';
  joinBtn.disabled = false;
});
socket.on('disconnect', () => {
  lobbyStatus.textContent = '⚠ Disconnected. Refresh to reconnect.';
});
socket.on('connect_error', () => {
  lobbyStatus.textContent = '⚠ Connection failed. Retrying…';
});

socket.on('joined', data => {
  myId   = data.playerId;
  mySlot = data.slot;
  MAP_W  = data.mapW;
  MAP_H  = data.mapH;
  platforms = data.platforms;
  resizeCanvas();
});
socket.on('waiting', () => {
  lobbyStatus.textContent = `⏳ Room "${roomInput.value}" — Waiting for opponent. Share this code!`;
});
socket.on('roomFull', () => {
  lobbyStatus.textContent = '❌ Room full. Try a different code.';
  joinBtn.disabled = false;
});

socket.on('roundStart', data => {
  gameState = 'playing';
  readyPressed = false;
  charging = false;
  localChargeTime = 0;
  keys = { left: false, right: false };
  lobby.style.display = 'none';
  gameWrap.classList.add('active');
  overlay.classList.remove('active');
  roundNum++;
  rebuildWinPips();
  hudCenter.textContent = `ROUND ${roundNum}`;
  // Seed local player list from roundStart for first frame
  if (data.players) {
    players = data.players.map(p => ({
      ...makeClientPlayer(p.id, p.slot), wins: p.wins
    }));
  }
});

socket.on('state', data => {
  players  = data.players;
  javelins = data.javelins;
  updateHUD();
});

socket.on('roundEnd', data => {
  gameState = data.gameWinner ? 'gameOver' : 'roundEnd';
  charging = false; localChargeTime = 0;
  showOverlay(data);
});

socket.on('readyCount', ({ count }) => {
  overlayBtn.textContent = count >= 2
    ? 'Starting…'
    : (gameState === 'gameOver' ? `Play Again (${count}/2)` : `Next Round (${count}/2)`);
});

socket.on('opponentLeft', () => {
  gameState = 'lobby';
  overlayTitle.style.color = 'var(--text)';
  overlayTitle.textContent  = 'OPPONENT LEFT';
  overlaySub.textContent    = '';
  overlayWins.innerHTML     = '';
  overlayBtn.textContent    = 'Back to Lobby';
  overlay.classList.add('active');
  overlayBtn.onclick = () => location.reload();
});

// ── Overlay ───────────────────────────────────────────────────────────────────
function showOverlay(data) {
  const winsData = data.wins || [];
  const myW  = (winsData.find(w => w.id === myId)  || { wins: 0 }).wins;
  const enyW = (winsData.find(w => w.id !== myId)  || { wins: 0 }).wins;

  if (data.gameWinner) {
    const iWon = data.gameWinner === myId;
    overlayTitle.style.color = iWon ? 'var(--accent)' : 'var(--accent2)';
    overlayTitle.textContent = iWon ? '🏆 VICTORY' : '💀 DEFEAT';
    overlaySub.textContent   = 'Game Over';
    overlayBtn.textContent   = 'Play Again (0/2)';
  } else {
    const iWon = data.roundWinner === myId;
    overlayTitle.style.color = data.roundWinner
      ? (iWon ? 'var(--accent)' : 'var(--accent2)')
      : 'var(--text)';
    overlayTitle.textContent = data.roundWinner
      ? (iWon ? '✓ ROUND WIN' : 'ROUND LOST')
      : 'DRAW';
    overlaySub.textContent   = 'First to 3 wins';
    overlayBtn.textContent   = 'Next Round (0/2)';
  }

  overlayWins.innerHTML = `
    <div class="ow-slot"><div class="ow-label">YOU</div><div class="ow-num">${myW}</div></div>
    <div class="ow-slot"><div class="ow-label">VS</div><div class="ow-num" style="color:var(--dim);font-size:1.2rem">:</div></div>
    <div class="ow-slot"><div class="ow-label">ENEMY</div><div class="ow-num" style="color:var(--accent2)">${enyW}</div></div>
  `;
  overlay.classList.add('active');

  // Reset onclick to default
  overlayBtn.onclick = null;
}

overlayBtn.addEventListener('click', () => {
  if (overlayBtn.onclick) return; // handled by opponentLeft
  if ((gameState === 'roundEnd' || gameState === 'gameOver') && !readyPressed) {
    readyPressed = true;
    socket.emit('ready');
    overlayBtn.style.opacity = '0.6';
  }
});

// ── HUD ───────────────────────────────────────────────────────────────────────
function rebuildWinPips() {
  ['p1', 'p2'].forEach(key => {
    const el = document.getElementById(`wins-${key}`);
    el.innerHTML = '';
    for (let i = 0; i < WINS_TO_WIN; i++) {
      const pip = document.createElement('div');
      pip.className = 'win-pip';
      el.appendChild(pip);
    }
  });
}

const WINS_TO_WIN = 3;

function updateHUD() {
  const me    = players.find(p => p.id === myId);
  const enemy = players.find(p => p.id !== myId);
  if (me) {
    updateWinPips('p1', me.wins);
    document.getElementById('jav-p1').textContent = `⚡ ×${me.javelins}`;
  }
  if (enemy) {
    updateWinPips('p2', enemy.wins);
    document.getElementById('jav-p2').textContent = `⚡ ×${enemy.javelins}`;
  }

  // Update charge bar locally for smooth animation
  if (charging) {
    localChargeTime = Math.min((performance.now() - localChargeStart) / 1000, CHARGE_MAX);
    const pct = Math.round((localChargeTime / CHARGE_MAX) * 100);
    chargeFill.style.width = pct + '%';
    chargePct.textContent  = pct + '%';
  } else {
    chargeFill.style.width = '0%';
    chargePct.textContent  = '0%';
  }
}

function updateWinPips(key, wins) {
  const pips = document.getElementById(`wins-${key}`).querySelectorAll('.win-pip');
  pips.forEach((pip, i) => pip.classList.toggle('filled', i < wins));
}

// ── Canvas helpers ─────────────────────────────────────────────────────────────
function roundRectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Render ─────────────────────────────────────────────────────────────────────
const COLORS = {
  sky: '#080b14', platform: '#1e2a45', platTop: '#3456a0',
  ground: '#141c30', groundTop: '#2040a0',
  playerMe: '#e8c13a', playerEn: '#e84a3a',
  javFly: '#c8e0ff', javStuck: '#7888aa',
  shadow: 'rgba(0,0,0,.5)',
  rollGlow: 'rgba(80,160,255,.35)',
  aimMe: 'rgba(232,193,58,.55)', aimEn: 'rgba(232,74,58,.45)',
  grid: 'rgba(30,42,75,.5)', star: 'rgba(190,205,255,.22)'
};

const STARS = Array.from({ length: 70 }, () => ({
  x: Math.random() * 1200, y: Math.random() * 540,
  r: Math.random() * 1.6 + 0.3
}));

function drawBg() {
  ctx.fillStyle = COLORS.sky;
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  ctx.fillStyle = COLORS.star;
  for (const s of STARS) {
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = .4;
  for (let x = 0; x < MAP_W; x += 80) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MAP_H); ctx.stroke(); }
  for (let y = 0; y < MAP_H; y += 80) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MAP_W,y); ctx.stroke(); }
}

function drawPlatforms() {
  for (const pl of platforms) {
    const big = pl.h > 30;
    ctx.fillStyle = big ? COLORS.ground : COLORS.platform;
    roundRectPath(pl.x, pl.y + 2, pl.w, pl.h, big ? 2 : 5);
    ctx.fill();
    ctx.fillStyle = big ? COLORS.groundTop : COLORS.platTop;
    ctx.fillRect(pl.x, pl.y, pl.w, 3);
    ctx.strokeStyle = 'rgba(50,90,200,.3)'; ctx.lineWidth = 1;
    roundRectPath(pl.x, pl.y, pl.w, pl.h, big ? 2 : 5);
    ctx.stroke();
  }
}

function drawJavelin(j) {
  ctx.save();
  const cx = j.x + JAVELIN_W / 2, cy = j.y + JAVELIN_H / 2;
  ctx.translate(cx, cy);
  ctx.rotate(j.angle);
  const len = 20;
  const grad = ctx.createLinearGradient(-len, 0, len, 0);
  const c = j.stuck ? '#8090b0' : '#d8ecff';
  grad.addColorStop(0, 'rgba(80,100,160,.8)');
  grad.addColorStop(.5, c);
  grad.addColorStop(1, 'rgba(80,100,160,.8)');
  ctx.strokeStyle = grad; ctx.lineWidth = j.stuck ? 2 : 3;
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len, 0); ctx.stroke();
  // tip
  ctx.fillStyle = j.stuck ? '#7080a8' : '#aad4ff';
  ctx.beginPath(); ctx.moveTo(len, 0); ctx.lineTo(len - 9, -4); ctx.lineTo(len - 9, 4); ctx.closePath(); ctx.fill();
  // tail feathers
  ctx.strokeStyle = 'rgba(160,190,255,.55)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-len + 4, 0); ctx.lineTo(-len - 7, -5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-len + 4, 0); ctx.lineTo(-len - 7,  5); ctx.stroke();
  ctx.restore();
}

const JAVELIN_W = 36, JAVELIN_H = 8;

function drawPlayer(p) {
  const isMe = p.id === myId;
  const col  = isMe ? COLORS.playerMe : COLORS.playerEn;
  const { x, y } = p;
  const cx = x + 14, cy = y + 20;

  ctx.save();

  if (p.rolling) {
    // invincibility glow
    ctx.shadowColor = COLORS.rollGlow; ctx.shadowBlur = 18;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 26);
    g.addColorStop(0, 'rgba(80,160,255,.3)'); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.fill();
  }

  // ground shadow
  ctx.shadowBlur = 0;
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath(); ctx.ellipse(cx, y + PLAYER_H - 2, 11, 3, 0, 0, Math.PI * 2); ctx.fill();

  ctx.shadowColor = col;
  ctx.shadowBlur  = p.rolling ? 0 : 10;
  ctx.fillStyle   = p.rolling ? 'rgba(80,160,255,.65)' : col;

  if (p.rolling) {
    roundRectPath(x - 6, y + 12, 48, 20, 10);
    ctx.fill();
  } else {
    // torso
    roundRectPath(x + 4, y + 16, 20, 24, 4); ctx.fill();
    // head
    ctx.beginPath(); ctx.arc(cx, y + 12, 9, 0, Math.PI * 2); ctx.fill();
    // eye
    ctx.shadowBlur = 0; ctx.fillStyle = '#06080f';
    ctx.beginPath(); ctx.arc(cx + p.facing * 5, y + 11, 2.5, 0, Math.PI * 2); ctx.fill();
    // legs (animate if moving)
    ctx.fillStyle = col;
    const legOff = (p.vx !== 0 && p.onGround) ? Math.sin(Date.now() / 80) * 3 : 0;
    ctx.fillRect(x + 5,  y + 38, 7, 6 + legOff);
    ctx.fillRect(x + 16, y + 38, 7, 6 - legOff);
  }

  // aim line
  ctx.shadowBlur = 0;
  ctx.strokeStyle = isMe ? COLORS.aimMe : COLORS.aimEn;
  ctx.lineWidth   = isMe ? 1.5 : 1;
  ctx.setLineDash([5, 5]);
  const aimLen = isMe && charging
    ? 45 + (localChargeTime / CHARGE_MAX) * 60
    : 40;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx + Math.cos(p.aimAngle) * aimLen, cy - 8 + Math.sin(p.aimAngle) * aimLen);
  ctx.stroke();
  ctx.setLineDash([]);

  // label
  ctx.fillStyle = isMe ? 'rgba(232,193,58,.95)' : 'rgba(232,74,58,.85)';
  ctx.font = `bold 10px "Share Tech Mono",monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(isMe ? 'YOU' : 'FOE', cx, y - 5);

  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  drawBg();
  drawPlatforms();

  // stuck javelins first
  for (const j of javelins) { if (j.stuck)  drawJavelin(j); }
  for (const j of javelins) { if (!j.stuck) drawJavelin(j); }

  for (const p of players) {
    if (!p.dead) drawPlayer(p);
  }

  // charge indicator ring on player
  if (charging) {
    const me = players.find(p => p.id === myId);
    if (me) {
      const pct = localChargeTime / CHARGE_MAX;
      const cx = me.x + 14, cy = me.y + 20;
      ctx.save();
      ctx.strokeStyle = `hsl(${50 - pct * 50},100%,60%)`;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(cx, cy, 18 + pct * 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
      ctx.stroke();
      ctx.restore();
    }
  }

  requestAnimationFrame(render);
}

function makeClientPlayer(id, slot) {
  return {
    id, slot,
    x: slot === 0 ? 140 : 1032, y: 480,
    vx: 0, vy: 0,
    facing: slot === 0 ? 1 : -1,
    aimAngle: slot === 0 ? -0.3 : Math.PI + 0.3,
    rolling: false, charging: false, chargeTime: 0,
    javelins: 1, dead: false, wins: 0, onGround: true
  };
}

requestAnimationFrame(render);
resizeCanvas();
