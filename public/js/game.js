/* ─── game.js ─────────────────────────────────────────────────────────────── */
const socket = io();

// ── DOM refs ──────────────────────────────────────────────────────────────────
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

// ── Game state ─────────────────────────────────────────────────────────────────
let myId = null, mySlot = null;
let platforms = [];
let players = [];
let javelins = [];
let MAP_W = 1200, MAP_H = 600;
let mouseX = 0, mouseY = 0;
let keys = { left: false, right: false, jump: false };
let mouseDown = false;
let charging = false;
let chargeTime = 0;
const CHARGE_MAX = 1.8;
let roundNum = 1;
let gameState = 'lobby'; // lobby | playing | roundEnd | gameOver

// Camera / canvas scale
let scale = 1, offX = 0, offY = 0;

function resizeCanvas() {
  const maxW = window.innerWidth - 32;
  const maxH = window.innerHeight - 120;
  scale = Math.min(maxW / MAP_W, maxH / MAP_H);
  canvas.width  = MAP_W;
  canvas.height = MAP_H;
  canvas.style.width  = Math.floor(MAP_W * scale) + 'px';
  canvas.style.height = Math.floor(MAP_H * scale) + 'px';
}
window.addEventListener('resize', resizeCanvas);

// ── Input ─────────────────────────────────────────────────────────────────────
function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / scale,
    y: (e.clientY - rect.top)  / scale
  };
}

document.addEventListener('keydown', e => {
  if (gameState !== 'playing') return;
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft')  { keys.left  = true; sendInput(); }
  if (k === 'd' || k === 'arrowright') { keys.right = true; sendInput(); }
  if ((k === 'w' || k === ' ' || k === 'arrowup') && !keys.jump) {
    keys.jump = true; sendInput();
  }
  if (k === 'f' || k === 'shift') socket.emit('roll');
});
document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === 'a' || k === 'arrowleft')  { keys.left  = false; sendInput(); }
  if (k === 'd' || k === 'arrowright') { keys.right = false; sendInput(); }
  if (k === 'w' || k === ' ' || k === 'arrowup') { keys.jump = false; sendInput(); }
});

canvas.addEventListener('mousemove', e => {
  const p = canvasPos(e);
  mouseX = p.x; mouseY = p.y;
  sendAim();
});
canvas.addEventListener('mousedown', e => {
  if (e.button !== 0 || gameState !== 'playing') return;
  mouseDown = true;
  charging = true;
  chargeTime = 0;
  socket.emit('startCharge');
});
canvas.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  if (charging && gameState === 'playing') {
    const me = players.find(p => p.id === myId);
    if (me) {
      const angle = Math.atan2(mouseY - (me.y + 20), mouseX - (me.x + 14));
      socket.emit('releaseThrow', { aimAngle: angle });
    }
  }
  charging = false;
  mouseDown = false;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

// prevent space scrolling
window.addEventListener('keydown', e => {
  if (e.key === ' ') e.preventDefault();
}, { passive: false });

function sendInput() {
  socket.emit('input', { keys: { ...keys } });
}
function sendAim() {
  const me = players.find(p => p.id === myId);
  if (!me) return;
  const angle = Math.atan2(mouseY - (me.y + 20), mouseX - (me.x + 14));
  socket.emit('input', { aimAngle: angle, keys: { ...keys } });
}

// ── Lobby ──────────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const id = roomInput.value.trim().toUpperCase() || randomRoomId();
  roomInput.value = id;
  lobbyStatus.textContent = 'Connecting…';
  socket.emit('joinRoom', { roomId: id });
});
roomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinBtn.click();
});

function randomRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('joined', data => {
  myId   = data.playerId;
  mySlot = data.slot;
  MAP_W  = data.mapW;
  MAP_H  = data.mapH;
  platforms = data.platforms;
  resizeCanvas();
});
socket.on('waiting', () => {
  lobbyStatus.textContent = '⏳ Waiting for opponent… Share the Room ID above!';
});
socket.on('roomFull', () => {
  lobbyStatus.textContent = '❌ Room is full. Try a different ID.';
});

socket.on('roundStart', data => {
  gameState = 'playing';
  lobby.style.display = 'none';
  gameWrap.classList.add('active');
  overlay.classList.remove('active');
  roundNum++;
  updateHUDNames(data.players);
  hudCenter.textContent = `ROUND ${roundNum - 1}`;
});

socket.on('state', data => {
  players  = data.players;
  javelins = data.javelins;
  updateHUD();
  updateChargeBar();
});

socket.on('roundEnd', data => {
  gameState = data.gameWinner ? 'gameOver' : 'roundEnd';
  showOverlay(data);
});

socket.on('opponentLeft', () => {
  overlayTitle.textContent   = 'OPPONENT LEFT';
  overlaySub.textContent     = '';
  overlayWins.innerHTML      = '';
  overlayBtn.textContent     = 'Back to Lobby';
  overlay.classList.add('active');
  overlayBtn.onclick = () => location.reload();
});

// ── Overlay ────────────────────────────────────────────────────────────────────
function showOverlay(data) {
  const me    = players.find(p => p.id === myId) || { wins: 0, slot: mySlot };
  const enemy = players.find(p => p.id !== myId) || { wins: 0 };

  if (data.gameWinner) {
    const iWon = data.gameWinner === myId;
    overlayTitle.style.color = iWon ? 'var(--accent)' : 'var(--accent2)';
    overlayTitle.textContent  = iWon ? '🏆 VICTORY' : '💀 DEFEAT';
    overlaySub.textContent    = 'Game Over';
    overlayBtn.textContent    = 'Play Again';
  } else {
    const iWon = data.roundWinner === myId;
    overlayTitle.style.color = data.roundWinner ? (iWon ? 'var(--accent)' : 'var(--accent2)') : 'var(--text)';
    overlayTitle.textContent  = data.roundWinner
      ? (iWon ? 'ROUND WIN ✓' : 'ROUND LOST')
      : 'DRAW';
    overlaySub.textContent    = 'First to 3 wins';
    overlayBtn.textContent    = 'Next Round';
  }

  const winsData = data.wins || [];
  const myW   = (winsData.find(w => w.id === myId)  || { wins: 0 }).wins;
  const enyW  = (winsData.find(w => w.id !== myId)  || { wins: 0 }).wins;

  overlayWins.innerHTML = `
    <div class="ow-slot">
      <div class="ow-label">YOU</div>
      <div class="ow-num">${myW}</div>
    </div>
    <div class="ow-slot">
      <div class="ow-label">—</div>
      <div class="ow-num" style="color:var(--dim)">:</div>
    </div>
    <div class="ow-slot">
      <div class="ow-label">ENEMY</div>
      <div class="ow-num" style="color:var(--accent2)">${enyW}</div>
    </div>
  `;
  overlay.classList.add('active');
}

overlayBtn.addEventListener('click', () => {
  if (gameState === 'roundEnd' || gameState === 'gameOver') {
    socket.emit('restartRound');
    overlay.classList.remove('active');
  }
});

// ── HUD ────────────────────────────────────────────────────────────────────────
function updateHUDNames(plist) {
  // Rebuild win pips
  ['p1', 'p2'].forEach((key, i) => {
    const el = document.getElementById(`wins-${key}`);
    el.innerHTML = '';
    for (let w = 0; w < 3; w++) {
      const pip = document.createElement('div');
      pip.className = 'win-pip';
      el.appendChild(pip);
    }
  });
}

function updateHUD() {
  const me    = players.find(p => p.id === myId);
  const enemy = players.find(p => p.id !== myId);

  if (me)    { updateWinPips('p1', me.wins);    document.getElementById('jav-p1').textContent = `🗡 ×${me.javelins}`; }
  if (enemy) { updateWinPips('p2', enemy.wins); document.getElementById('jav-p2').textContent = `🗡 ×${enemy.javelins}`; }
}

function updateWinPips(key, wins) {
  const pips = document.getElementById(`wins-${key}`).querySelectorAll('.win-pip');
  pips.forEach((pip, i) => pip.classList.toggle('filled', i < wins));
}

function updateChargeBar() {
  const me = players.find(p => p.id === myId);
  if (!me || !me.charging) {
    chargeFill.style.width = '0%';
    chargePct.textContent  = '0%';
    return;
  }
  const pct = Math.round((me.chargeTime / CHARGE_MAX) * 100);
  chargeFill.style.width = pct + '%';
  chargePct.textContent  = pct + '%';
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
  sky:      '#080b14',
  ground:   '#1a2035',
  groundTop:'#2a3a60',
  platform: '#1e2a45',
  platTop:  '#2e4070',
  playerMe: '#e8c13a',
  playerEn: '#e84a3a',
  javFly:   '#c8d8f8',
  javStuck: '#8898b8',
  shadow:   'rgba(0,0,0,.4)',
  rollGlow: 'rgba(100,180,255,.3)',
  aimLine:  'rgba(232,193,58,.4)',
  aimLineEn:'rgba(232,74,58,.3)',
  gridLine: 'rgba(30,40,70,.6)',
  star:     'rgba(200,210,255,.25)'
};

// pre-baked star field
const STARS = Array.from({ length: 60 }, () => ({
  x: Math.random() * 1200,
  y: Math.random() * 540,
  r: Math.random() * 1.5 + .3
}));

function drawBackground() {
  ctx.fillStyle = COLORS.sky;
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  // stars
  ctx.fillStyle = COLORS.star;
  for (const s of STARS) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // subtle grid
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = .5;
  for (let gx = 0; gx < MAP_W; gx += 80) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, MAP_H); ctx.stroke();
  }
  for (let gy = 0; gy < MAP_H; gy += 80) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(MAP_W, gy); ctx.stroke();
  }
}

function drawPlatforms() {
  for (const pl of platforms) {
    const isGround = pl.h > 30;
    // body
    ctx.fillStyle = COLORS.platform;
    roundRectPath(pl.x, pl.y + 3, pl.w, pl.h, isGround ? 2 : 4);
    ctx.fill();
    // top highlight
    ctx.fillStyle = isGround ? COLORS.groundTop : COLORS.platTop;
    ctx.fillRect(pl.x, pl.y, pl.w, 3);
    // edge glow
    ctx.strokeStyle = 'rgba(60,100,180,.4)';
    ctx.lineWidth = 1;
    roundRectPath(pl.x, pl.y, pl.w, pl.h, isGround ? 2 : 4);
    ctx.stroke();
  }
}

function drawJavelin(j) {
  ctx.save();
  ctx.translate(j.x + 18, j.y + 4);
  ctx.rotate(j.angle);
  // shaft
  const grad = ctx.createLinearGradient(-18, 0, 18, 0);
  grad.addColorStop(0, j.stuck ? COLORS.javStuck : '#a0b4d8');
  grad.addColorStop(.5, j.stuck ? '#b8c8e0' : '#e8f0ff');
  grad.addColorStop(1, '#6070a0');
  ctx.strokeStyle = grad;
  ctx.lineWidth = j.stuck ? 2.5 : 3;
  ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(18, 0); ctx.stroke();
  // tip
  ctx.fillStyle = j.stuck ? '#8090b0' : '#cce0ff';
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(10, -4);
  ctx.lineTo(10,  4);
  ctx.closePath(); ctx.fill();
  // feather
  ctx.strokeStyle = 'rgba(180,200,255,.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(-20, -5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(-20,  5); ctx.stroke();
  ctx.restore();
}

function drawPlayer(p) {
  const isMe = p.id === myId;
  const color = isMe ? COLORS.playerMe : COLORS.playerEn;
  const { x, y } = p;
  const cx = x + 14, cy = y + 20;

  ctx.save();

  // roll glow (invincibility)
  if (p.rolling) {
    ctx.shadowColor = COLORS.rollGlow;
    ctx.shadowBlur  = 20;
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 24);
    g.addColorStop(0, 'rgba(100,180,255,.25)');
    g.addColorStop(1, 'rgba(100,180,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.fill();
  }

  // shadow
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(cx, y + 40, 12, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // body
  ctx.shadowColor = color;
  ctx.shadowBlur  = p.rolling ? 0 : 8;
  ctx.fillStyle   = p.rolling ? 'rgba(100,180,255,.6)' : color;

  if (p.rolling) {
    // roll = horizontal capsule
    roundRectPath(x - 4, y + 10, 44, 22, 11);
    ctx.fill();
  } else {
    // torso
    roundRectPath(x + 4, y + 16, 20, 24, 4);
    ctx.fill();
    // head
    ctx.beginPath();
    ctx.arc(cx, y + 12, 9, 0, Math.PI * 2);
    ctx.fill();
    // eye
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0a0c10';
    const eyeX = cx + p.facing * 5;
    ctx.beginPath();
    ctx.arc(eyeX, y + 11, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // legs
    ctx.fillStyle = color;
    ctx.fillRect(x + 5,  y + 38, 7, 6);
    ctx.fillRect(x + 16, y + 38, 7, 6);
  }

  // aim line (only if not dead, only my own aim for me, enemy for their slot)
  if (!p.dead) {
    const aimColor = isMe ? COLORS.aimLine : COLORS.aimLineEn;
    ctx.shadowBlur = 0;
    ctx.strokeStyle = aimColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    const len = 50 + (isMe && p.charging ? (p.chargeTime / CHARGE_MAX) * 50 : 0);
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx + Math.cos(p.aimAngle) * len, cy - 8 + Math.sin(p.aimAngle) * len);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // YOU label
  if (isMe) {
    ctx.shadowBlur = 0;
    ctx.fillStyle  = 'rgba(232,193,58,.9)';
    ctx.font       = 'bold 10px "Share Tech Mono", monospace';
    ctx.textAlign  = 'center';
    ctx.fillText('YOU', cx, y - 4);
  }

  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  drawBackground();
  drawPlatforms();

  // javelins behind players
  for (const j of javelins) {
    if (j.stuck) drawJavelin(j);
  }
  // flying javelins
  for (const j of javelins) {
    if (!j.stuck) drawJavelin(j);
  }

  for (const p of players) {
    if (!p.dead) drawPlayer(p);
  }

  requestAnimationFrame(render);
}

requestAnimationFrame(render);
resizeCanvas();
