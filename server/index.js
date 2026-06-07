const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 30000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, '../public')));

// ─── Constants ───────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const MAP_W = 1200;
const MAP_H = 600;
const PLAYER_W = 28;
const PLAYER_H = 40;
const PLAYER_SPEED = 240;
const GRAVITY = 860;
const JUMP_VY = -500;
const ROLL_DURATION = 0.42;
const ROLL_INVINCIBLE = 0.38;
const ROLL_SPEED = 480;
const JAVELIN_SPEED_MIN = 480;
const JAVELIN_SPEED_MAX = 1200;
const JAVELIN_W = 36;
const JAVELIN_H = 8;
const CHARGE_MAX = 1.8;
const WINS_TO_WIN = 3;
const PICKUP_RANGE = 28;   // extra pickup radius
const ROUND_RESTART_DELAY = 500; // ms after second player ready

const PLATFORMS = [
  { x: 0,    y: 540, w: 1200, h: 60  },
  { x: 100,  y: 420, w: 220,  h: 18  },
  { x: 390,  y: 355, w: 180,  h: 18  },
  { x: 630,  y: 420, w: 220,  h: 18  },
  { x: 480,  y: 475, w: 240,  h: 18  },
  { x: 210,  y: 285, w: 150,  h: 18  },
  { x: 840,  y: 285, w: 150,  h: 18  },
  { x: 520,  y: 220, w: 160,  h: 18  },
];

const rooms = {};

function makePlayer(id, slot) {
  return {
    id, slot,
    x: slot === 0 ? 140 : 1032,
    y: 480,
    vx: 0, vy: 0,
    onGround: false,
    facing: slot === 0 ? 1 : -1,
    aimAngle: slot === 0 ? -0.3 : Math.PI + 0.3,
    charging: false,
    chargeTime: 0,
    rolling: false,
    rollTimer: 0,
    rollDir: 1,
    dead: false,
    javelins: 1,
    wins: 0,
    jumpRequested: false,
    rollRequested: false,
    keys: { left: false, right: false }
  };
}

function makeJavelin(id, ox, oy, vx, vy, ownerId) {
  return {
    id, x: ox, y: oy, vx, vy,
    angle: Math.atan2(vy, vx),
    stuck: false, ownerId, dead: false
  };
}

function makeRoom(roomId) {
  return {
    roomId,
    players: [],
    javelins: [],
    nextJavelinId: 0,
    state: 'waiting',
    roundWinner: null,
    gameWinner: null,
    tickInterval: null,
    readyCount: 0,
    restartTimeout: null
  };
}

// ─── Physics ─────────────────────────────────────────────────────────────────
function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function resolvePlayerPlatforms(p) {
  p.onGround = false;
  for (const pl of PLATFORMS) {
    // only snap down onto top surface
    if (
      p.x + PLAYER_W > pl.x + 2 &&
      p.x < pl.x + pl.w - 2 &&
      p.y + PLAYER_H > pl.y &&
      p.y + PLAYER_H <= pl.y + pl.h + Math.max(p.vy * DT * 2, 12) &&
      p.vy >= 0
    ) {
      p.y = pl.y - PLAYER_H;
      p.vy = 0;
      p.onGround = true;
    }
  }
  if (p.x < 0) { p.x = 0; p.vx = 0; }
  if (p.x + PLAYER_W > MAP_W) { p.x = MAP_W - PLAYER_W; p.vx = 0; }
  if (p.y > MAP_H + 20) p.dead = true;
}

function resolveJavelinPlatforms(j) {
  for (const pl of PLATFORMS) {
    if (rectOverlap(j.x, j.y, JAVELIN_W, JAVELIN_H, pl.x, pl.y, pl.w, pl.h)) {
      // snap tip to surface top
      j.y = pl.y - JAVELIN_H * 0.5;
      j.stuck = true; j.vx = 0; j.vy = 0;
      return;
    }
  }
  if (j.y > MAP_H + 40 || j.x < -200 || j.x > MAP_W + 200) j.dead = true;
}

// ─── Game tick ────────────────────────────────────────────────────────────────
function gameTick(room) {
  if (room.state !== 'playing') return;
  const [p0, p1] = room.players;
  if (!p0 || !p1) return;

  for (const p of room.players) {
    if (p.dead) continue;

    if (!p.rolling) {
      let dx = 0;
      if (p.keys.left)  dx -= 1;
      if (p.keys.right) dx += 1;
      p.vx = dx * PLAYER_SPEED;
      if (dx !== 0) p.facing = dx;
    } else {
      p.vx = p.rollDir * ROLL_SPEED;
      p.rollTimer -= DT;
      if (p.rollTimer <= 0) { p.rolling = false; p.vx = 0; }
    }

    // gravity
    p.vy += GRAVITY * DT;

    // edge-triggered jump
    if (p.jumpRequested && p.onGround && !p.rolling) {
      p.vy = JUMP_VY;
      p.onGround = false;
    }
    p.jumpRequested = false;

    // edge-triggered roll
    if (p.rollRequested && !p.rolling) {
      p.rolling = true;
      p.rollTimer = ROLL_DURATION;
      // prefer movement direction, fall back to facing
      if (p.keys.left)       p.rollDir = -1;
      else if (p.keys.right) p.rollDir =  1;
      else                   p.rollDir = p.facing;
    }
    p.rollRequested = false;

    // charging
    if (p.charging && p.javelins > 0) {
      p.chargeTime = Math.min(p.chargeTime + DT, CHARGE_MAX);
    }

    p.x += p.vx * DT;
    p.y += p.vy * DT;
    resolvePlayerPlatforms(p);
  }

  // javelins
  for (const j of room.javelins) {
    if (j.stuck || j.dead) continue;
    j.vy += GRAVITY * DT;
    j.x  += j.vx * DT;
    j.y  += j.vy * DT;
    j.angle = Math.atan2(j.vy, j.vx);
    resolveJavelinPlatforms(j);
  }

  // pickup (larger hitbox)
  for (const p of room.players) {
    if (p.dead) continue;
    const pcx = p.x + PLAYER_W / 2, pcy = p.y + PLAYER_H / 2;
    for (const j of room.javelins) {
      if (!j.stuck || j.dead) continue;
      const jcx = j.x + JAVELIN_W / 2, jcy = j.y + JAVELIN_H / 2;
      if (Math.abs(pcx - jcx) < PLAYER_W + PICKUP_RANGE && Math.abs(pcy - jcy) < PLAYER_H) {
        p.javelins++;
        j.dead = true;
      }
    }
  }

  // hit detection
  for (const j of room.javelins) {
    if (j.stuck || j.dead) continue;
    for (const p of room.players) {
      if (p.dead || p.id === j.ownerId) continue;
      // invincible for first ROLL_INVINCIBLE seconds of roll
      if (p.rolling && p.rollTimer > ROLL_DURATION - ROLL_INVINCIBLE) continue;
      if (rectOverlap(j.x, j.y, JAVELIN_W, JAVELIN_H, p.x + 4, p.y + 4, PLAYER_W - 8, PLAYER_H - 8)) {
        p.dead = true; j.dead = true;
      }
    }
  }

  room.javelins = room.javelins.filter(j => !j.dead);

  // round end check
  const dead = room.players.filter(p => p.dead);
  if (dead.length > 0) {
    const winner = room.players.find(p => !p.dead);
    if (winner) { winner.wins++; room.roundWinner = winner.id; }
    else         { room.roundWinner = null; }

    if (winner && winner.wins >= WINS_TO_WIN) {
      room.state = 'gameOver';
      room.gameWinner = winner.id;
    } else {
      room.state = 'roundEnd';
    }
    room.readyCount = 0;
    io.to(room.roomId).emit('roundEnd', {
      roundWinner: room.roundWinner,
      gameWinner: room.gameWinner,
      wins: room.players.map(p => ({ id: p.id, wins: p.wins }))
    });
    return;
  }

  // state snapshot
  io.to(room.roomId).emit('state', {
    players: room.players.map(p => ({
      id: p.id, slot: p.slot,
      x: p.x, y: p.y,
      vx: p.vx, vy: p.vy,
      facing: p.facing,
      aimAngle: p.aimAngle,
      rolling: p.rolling,
      charging: p.charging,
      chargeTime: p.chargeTime,
      javelins: p.javelins,
      dead: p.dead,
      wins: p.wins,
      onGround: p.onGround
    })),
    javelins: room.javelins.map(j => ({
      id: j.id, x: j.x, y: j.y,
      angle: j.angle, stuck: j.stuck, ownerId: j.ownerId
    }))
  });
}

function resetRound(room) {
  if (room.restartTimeout) { clearTimeout(room.restartTimeout); room.restartTimeout = null; }
  room.javelins = [];
  room.roundWinner = null;
  room.readyCount = 0;
  room.state = 'playing';
  for (const p of room.players) {
    p.x = p.slot === 0 ? 140 : 1032;
    p.y = 480; p.vx = 0; p.vy = 0;
    p.dead = false; p.charging = false; p.chargeTime = 0;
    p.rolling = false; p.rollTimer = 0; p.javelins = 1;
    p.facing = p.slot === 0 ? 1 : -1;
    p.aimAngle = p.slot === 0 ? -0.3 : Math.PI + 0.3;
    p.jumpRequested = false; p.rollRequested = false;
    p.keys = { left: false, right: false };
  }
  io.to(room.roomId).emit('roundStart', {
    players: room.players.map(p => ({ id: p.id, slot: p.slot, wins: p.wins }))
  });
}

function startGame(room) {
  for (const p of room.players) p.wins = 0;
  resetRound(room);
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => gameTick(room), 1000 / TICK_RATE);
}

// ─── Sockets ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', ({ roomId }) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toUpperCase().slice(0, 8);
    if (!rooms[roomId]) rooms[roomId] = makeRoom(roomId);
    const room = rooms[roomId];
    if (room.players.length >= 2) { socket.emit('roomFull'); return; }
    currentRoom = room;
    const slot = room.players.length;
    const player = makePlayer(socket.id, slot);
    room.players.push(player);
    socket.join(roomId);
    socket.emit('joined', { playerId: socket.id, slot, roomId, platforms: PLATFORMS, mapW: MAP_W, mapH: MAP_H });
    if (room.players.length === 2) {
      room.state = 'playing';
      startGame(room);
    } else {
      socket.emit('waiting');
    }
  });

  socket.on('input', (data) => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (!p || p.dead) return;
    if (data.keys) {
      p.keys.left  = !!data.keys.left;
      p.keys.right = !!data.keys.right;
      // jump is edge-triggered via separate event, but keep compat
    }
    if (typeof data.aimAngle === 'number') p.aimAngle = data.aimAngle;
  });

  socket.on('jump', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (!p || p.dead) return;
    p.jumpRequested = true;
  });

  socket.on('startCharge', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (!p || p.dead || p.javelins <= 0) return;
    p.charging = true;
    p.chargeTime = 0;
  });

  socket.on('releaseThrow', ({ aimAngle }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (!p || p.dead || !p.charging || p.javelins <= 0) return;
    const t = p.chargeTime / CHARGE_MAX;
    const speed = JAVELIN_SPEED_MIN + t * (JAVELIN_SPEED_MAX - JAVELIN_SPEED_MIN);
    const angle = typeof aimAngle === 'number' ? aimAngle : p.aimAngle;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    const j = makeJavelin(
      currentRoom.nextJavelinId++,
      p.x + PLAYER_W / 2, p.y + PLAYER_H / 2 - 8,
      vx, vy, socket.id
    );
    currentRoom.javelins.push(j);
    p.javelins--;
    p.charging = false;
    p.chargeTime = 0;
  });

  socket.on('cancelCharge', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (p) { p.charging = false; p.chargeTime = 0; }
  });

  socket.on('roll', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (!p || p.dead || p.rolling) return;
    p.rollRequested = true;
  });

  // Both players must press ready to restart
  socket.on('ready', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    if (room.state !== 'roundEnd' && room.state !== 'gameOver') return;
    room.readyCount++;
    io.to(room.roomId).emit('readyCount', { count: room.readyCount });
    if (room.readyCount >= 2) {
      if (room.restartTimeout) clearTimeout(room.restartTimeout);
      room.restartTimeout = setTimeout(() => {
        if (room.state === 'gameOver') {
          for (const p of room.players) p.wins = 0;
        }
        resetRound(room);
      }, ROUND_RESTART_DELAY);
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    // Remove player from room
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
    if (room.restartTimeout) { clearTimeout(room.restartTimeout); room.restartTimeout = null; }
    io.to(room.roomId).emit('opponentLeft');
    // Only delete room if empty
    if (room.players.length === 0) delete rooms[room.roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Javelin server on :${PORT}`));
