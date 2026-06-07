const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, '../public')));

// ─── Constants ───────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const MAP_W = 1200;
const MAP_H = 600;
const PLAYER_W = 28;
const PLAYER_H = 40;
const PLAYER_SPEED = 220;
const GRAVITY = 900;
const JUMP_VY = -480;
const ROLL_DURATION = 0.45;
const ROLL_INVINCIBLE = 0.35;
const ROLL_SPEED = 500;
const JAVELIN_SPEED_MIN = 500;
const JAVELIN_SPEED_MAX = 1300;
const JAVELIN_W = 36;
const JAVELIN_H = 8;
const CHARGE_MAX = 1.8;
const WINS_TO_WIN = 3;

// ─── Platforms ────────────────────────────────────────────────────────────────
const PLATFORMS = [
  { x: 0,    y: 540, w: 1200, h: 60  }, // ground
  { x: 120,  y: 420, w: 200,  h: 20  },
  { x: 400,  y: 360, w: 160,  h: 20  },
  { x: 640,  y: 420, w: 200,  h: 20  },
  { x: 490,  y: 480, w: 220,  h: 20  },
  { x: 220,  y: 290, w: 140,  h: 20  },
  { x: 840,  y: 290, w: 140,  h: 20  },
  { x: 530,  y: 230, w: 140,  h: 20  },
];

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = {};

function makePlayer(id, slot) {
  return {
    id,
    slot,
    x: slot === 0 ? 150 : 1000,
    y: 480,
    vx: 0,
    vy: 0,
    onGround: false,
    facing: slot === 0 ? 1 : -1,
    aimAngle: 0,
    charging: false,
    chargeTime: 0,
    rolling: false,
    rollTimer: 0,
    rollDir: 1,
    dead: false,
    javelins: 1,        // carried count
    wins: 0,
    keys: { left: false, right: false, jump: false }
  };
}

function makeJavelin(id, ox, oy, vx, vy, ownerId) {
  return {
    id,
    x: ox, y: oy,
    vx, vy,
    angle: Math.atan2(vy, vx),
    stuck: false,
    stuckTimer: 0,
    ownerId,
    dead: false
  };
}

function makeRoom(roomId) {
  return {
    roomId,
    players: [],
    javelins: [],
    nextJavelinId: 0,
    state: 'waiting',   // waiting | playing | roundEnd | gameOver
    roundWinner: null,
    gameWinner: null,
    tickInterval: null
  };
}

// ─── Collision helpers ────────────────────────────────────────────────────────
function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function resolvePlayerPlatforms(p) {
  p.onGround = false;
  for (const pl of PLATFORMS) {
    if (
      p.x + PLAYER_W > pl.x &&
      p.x < pl.x + pl.w &&
      p.y + PLAYER_H > pl.y &&
      p.y + PLAYER_H <= pl.y + pl.h + 8 &&
      p.vy >= 0
    ) {
      p.y = pl.y - PLAYER_H;
      p.vy = 0;
      p.onGround = true;
    }
  }
  // world bounds
  if (p.x < 0) { p.x = 0; p.vx = 0; }
  if (p.x + PLAYER_W > MAP_W) { p.x = MAP_W - PLAYER_W; p.vx = 0; }
  if (p.y > MAP_H) { p.dead = true; } // fell off
}

function resolveJavelinPlatforms(j) {
  if (j.stuck) return;
  for (const pl of PLATFORMS) {
    if (
      j.x + JAVELIN_W > pl.x && j.x < pl.x + pl.w &&
      j.y + JAVELIN_H > pl.y && j.y < pl.y + pl.h
    ) {
      j.stuck = true;
      j.vx = 0;
      j.vy = 0;
      return;
    }
  }
  if (j.y > MAP_H + 40) j.dead = true;
  if (j.x < -100 || j.x > MAP_W + 100) j.dead = true;
}

// ─── Game tick ────────────────────────────────────────────────────────────────
function gameTick(room) {
  if (room.state !== 'playing') return;

  const [p0, p1] = room.players;
  if (!p0 || !p1) return;

  for (const p of room.players) {
    if (p.dead) continue;

    // Horizontal movement
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

    // Gravity
    p.vy += GRAVITY * DT;

    // Jump
    if (p.keys.jump && p.onGround) {
      p.vy = JUMP_VY;
      p.onGround = false;
    }

    // Charging
    if (p.charging && p.javelins > 0) {
      p.chargeTime = Math.min(p.chargeTime + DT, CHARGE_MAX);
    }

    // Move
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    resolvePlayerPlatforms(p);
  }

  // Update javelins
  for (const j of room.javelins) {
    if (j.stuck || j.dead) continue;
    j.vy += GRAVITY * DT;
    j.x += j.vx * DT;
    j.y += j.vy * DT;
    j.angle = Math.atan2(j.vy, j.vx);
    resolveJavelinPlatforms(j);
  }

  // Pickup javelins
  for (const p of room.players) {
    if (p.dead) continue;
    for (const j of room.javelins) {
      if (!j.stuck || j.dead) continue;
      if (rectOverlap(p.x, p.y, PLAYER_W, PLAYER_H, j.x - 2, j.y - 2, JAVELIN_W + 4, JAVELIN_H + 4)) {
        p.javelins++;
        j.dead = true;
      }
    }
  }

  // Hit detection (only flying javelins)
  for (const j of room.javelins) {
    if (j.stuck || j.dead) continue;
    for (const p of room.players) {
      if (p.dead) continue;
      if (p.id === j.ownerId) continue;
      // invincible during roll
      if (p.rolling && p.rollTimer > ROLL_DURATION - ROLL_INVINCIBLE) continue;
      if (rectOverlap(j.x, j.y, JAVELIN_W, JAVELIN_H, p.x + 4, p.y + 4, PLAYER_W - 8, PLAYER_H - 8)) {
        p.dead = true;
        j.dead = true;
      }
    }
  }

  // Clean dead javelins
  room.javelins = room.javelins.filter(j => !j.dead);

  // Check round end
  const dead = room.players.filter(p => p.dead);
  if (dead.length > 0) {
    const winner = room.players.find(p => !p.dead);
    if (winner) {
      winner.wins++;
      room.roundWinner = winner.id;
    } else {
      room.roundWinner = null; // draw
    }
    if (winner && winner.wins >= WINS_TO_WIN) {
      room.state = 'gameOver';
      room.gameWinner = winner.id;
    } else {
      room.state = 'roundEnd';
    }
    io.to(room.roomId).emit('roundEnd', {
      roundWinner: room.roundWinner,
      gameWinner: room.gameWinner,
      wins: room.players.map(p => ({ id: p.id, wins: p.wins }))
    });
    return;
  }

  // Send state snapshot
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
      wins: p.wins
    })),
    javelins: room.javelins.map(j => ({
      id: j.id, x: j.x, y: j.y,
      vx: j.vx, vy: j.vy,
      angle: j.angle,
      stuck: j.stuck,
      ownerId: j.ownerId
    }))
  });
}

function resetRound(room) {
  room.javelins = [];
  room.roundWinner = null;
  room.state = 'playing';
  for (const p of room.players) {
    p.x = p.slot === 0 ? 150 : 1000;
    p.y = 480;
    p.vx = 0; p.vy = 0;
    p.dead = false;
    p.charging = false;
    p.chargeTime = 0;
    p.rolling = false;
    p.rollTimer = 0;
    p.javelins = 1;
    p.facing = p.slot === 0 ? 1 : -1;
  }
  io.to(room.roomId).emit('roundStart', { players: room.players.map(p => ({ id: p.id, slot: p.slot, wins: p.wins })) });
}

function startGame(room) {
  for (const p of room.players) {
    p.wins = 0;
  }
  resetRound(room);
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => gameTick(room), 1000 / TICK_RATE);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', ({ roomId }) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toUpperCase().slice(0, 8);
    if (!rooms[roomId]) rooms[roomId] = makeRoom(roomId);
    const room = rooms[roomId];
    if (room.players.length >= 2) {
      socket.emit('roomFull');
      return;
    }
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
      p.keys.jump  = !!data.keys.jump;
    }
    if (typeof data.aimAngle === 'number') p.aimAngle = data.aimAngle;
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
      p.x + PLAYER_W / 2,
      p.y + PLAYER_H / 2 - 8,
      vx, vy, socket.id
    );
    currentRoom.javelins.push(j);
    p.javelins--;
    p.charging = false;
    p.chargeTime = 0;
  });

  socket.on('roll', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.find(p => p.id === socket.id);
    if (!p || p.dead || p.rolling) return;
    p.rolling = true;
    p.rollTimer = ROLL_DURATION;
    p.rollDir = p.facing;
  });

  socket.on('restartRound', () => {
    if (!currentRoom) return;
    if (currentRoom.state === 'roundEnd') {
      resetRound(currentRoom);
    } else if (currentRoom.state === 'gameOver') {
      for (const p of currentRoom.players) p.wins = 0;
      resetRound(currentRoom);
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    io.to(currentRoom.roomId).emit('opponentLeft');
    clearInterval(currentRoom.tickInterval);
    delete rooms[currentRoom.roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Javelin server on :${PORT}`));
