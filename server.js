
'use strict';
// Titanic Kid Plays shared multiplayer v2
// Node.js 20+ — supports PRIMATE and Carnival.

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 65536;
const MAX_ROOMS = 120;
const MAX_PLAYERS = 4;
const GRACE = 120000;
const rooms = new Map();
const clients = new Set();
const colors = ['#c7ec77','#6ce2e8','#e0a7f9','#f7bf77'];
const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const games = (process.env.ALLOWED_GAMES || 'PrimateLab,CarnivalHorror')
  .split(',').map(x => x.trim()).filter(Boolean);

const now = () => Date.now();
const safeName = x => String(x || 'PLAYER')
  .replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 18) || 'PLAYER';

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/' || path === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      ok: true,
      service: 'Titanic Kid Plays Multiplayer',
      version: 2,
      rooms: rooms.size,
      players: clients.size,
      socket: '/socket',
      games
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

function roomCode() {
  let code;
  do {
    code = Array.from({ length: 6 },
      () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(c, obj) {
  if (c.closed || !c.socket.writable ||
      c.socket.writableLength > 350000) return;
  const body = Buffer.from(JSON.stringify(obj));
  let h;
  if (body.length < 126) {
    h = Buffer.from([0x81, body.length]);
  } else if (body.length <= 65535) {
    h = Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  } else return;
  c.socket.write(Buffer.concat([h, body]));
}

function frame(c, opcode, data = Buffer.alloc(0)) {
  if (c.closed || !c.socket.writable || data.length > 65535) return;
  const h = data.length < 126
    ? Buffer.from([0x80 | opcode, data.length])
    : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  c.socket.write(Buffer.concat([h, data]));
}

function broadcast(room, msg, except = null) {
  for (const c of room.members.values())
    if (c.id !== except && !c.closed) send(c, msg);
}

function roster(room) {
  return {
    type: 'roster',
    room: room.code,
    gameId: room.gameId,
    hostId: room.hostId,
    players: [...room.members.values()]
      .filter(c => !c.closed)
      .map(c => ({
        id: c.id, name: c.name, color: c.color, pose: c.pose
      }))
  };
}

function updateRoster(room) {
  broadcast(room, roster(room));
}

function leave(c) {
  const r = c.room;
  if (!r) return;
  c.room = null;
  r.members.delete(c.id);
  if (!r.members.size) {
    rooms.delete(r.code);
    return;
  }
  if (r.hostId === c.id) {
    r.hostId = [...r.members.values()].find(p => !p.closed)?.id ||
      r.members.keys().next().value;
  }
  updateRoster(r);
}

function join(c, r) {
  if (c.room) leave(c);
  if (r.members.size >= MAX_PLAYERS) {
    send(c, { type: 'error', message: 'Room full (4 players).' });
    return;
  }
  c.room = r;
  c.name = safeName(c.requestedName);
  c.resumeToken = crypto.randomBytes(24).toString('hex');
  const used = new Set([...r.members.values()].map(p => p.color));
  c.color = colors.find(x => !used.has(x)) || colors[0];
  r.members.set(c.id, c);
  if (!r.hostId) r.hostId = c.id;
  send(c, {
    type: 'joined',
    room: r.code, gameId: r.gameId,
    seed: r.seed, id: c.id,
    hostId: r.hostId, color: c.color,
    resumeToken: c.resumeToken
  });
  if (r.latestWorld)
    send(c, { type: 'world', world: r.latestWorld, seq: r.seq });
  updateRoster(r);
}

function resume(c, m) {
  const code = String(m.code || '').toUpperCase()
    .replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const r = rooms.get(code);
  if (!r || r.gameId !== m.gameId) {
    send(c, {
      type: 'error', code: 'ROOM_EXPIRED',
      message: 'Room was reset. Create a new room.'
    });
    return;
  }
  const old = [...r.members.values()].find(p =>
    p.closed && p.resumeToken === m.resumeToken &&
    typeof m.resumeToken === 'string' &&
    p.disconnectedAt && now() - p.disconnectedAt < GRACE
  );
  if (!old) {
    send(c, {
      type: 'error', code: 'RESUME_EXPIRED',
      message: 'Room reservation expired. Join again.'
    });
    return;
  }
  c.id = old.id;
  c.name = old.name;
  c.color = old.color;
  c.pose = old.pose;
  c.resumeToken = old.resumeToken;
  c.room = r;
  c.disconnectedAt = 0;
  old.room = null;
  r.members.set(c.id, c);
  send(c, {
    type: 'joined',
    room: r.code, gameId: r.gameId,
    seed: r.seed, id: c.id,
    hostId: r.hostId, color: c.color,
    resumeToken: c.resumeToken, resumed: true
  });
  if (r.latestWorld)
    send(c, { type: 'world', world: r.latestWorld, seq: r.seq });
  updateRoster(r);
}

const carnivalActions = new Set(['key','trap','advance']);
const actionKinds = new Set([
  'door','skull','core','switch','ghost','mod','exorcise',
  'banishGhost','transform','wall','gun','npcTool'
]);
const modIds = new Set([
  'spawn','horde','wave','scare','clear','revert',
  'openDoor','closeDoor','spawnNPC','duplicateNPC','resetLab',
  'spawnBlueGhost','spawnGreenGhost','spawnPurpleGhost',
  'spawnGoldGhost','spawnRedGhost','spawnGhostRandom',
  'dismissGhosts','dismissRedGhost','powerPulse','unlockGhosts'
]);

function allowedAction(c, a) {
  if (!a || typeof a.kind !== 'string') return false;
  if (c.room.gameId === 'CarnivalHorror') {
    return carnivalActions.has(a.kind) &&
      (a.kind !== 'key' ||
       (Number.isInteger(a.index) && a.index >= 0 && a.index < 3));
  }
  if (c.room.gameId !== 'PrimateLab') {
    return a.kind === 'interact' &&
      /^[a-zA-Z0-9_-]{1,40}$/.test(a.target || '');
  }
  if (!actionKinds.has(a.kind)) return false;
  if (a.kind === 'door') return typeof a.open === 'boolean';
  if (a.kind === 'skull') return Number.isInteger(a.index) &&
    a.index >= 0 && a.index < 3;
  if (a.kind === 'core') return Number.isInteger(a.index) &&
    a.index >= 0 && a.index < 4;
  if (a.kind === 'switch') return Number.isInteger(a.index) &&
    a.index >= 0 && a.index < 3;
  if (a.kind === 'ghost') return
    ['red','blue','green','purple','gold','random'].includes(a.color);
  if (a.kind === 'mod') return
    typeof a.id === 'string' && modIds.has(a.id);
  if (a.kind === 'wall') return Number.isInteger(a.index) &&
    a.index >= 0 && a.index < 11;
  if (a.kind === 'gun') return
    ['monsterGun','stunGun','cureGun','cloneGun','blastGun'].includes(a.tool) &&
    ['npc','monster','redGhost'].includes(a.targetType) &&
    Number.isInteger(a.uid) && a.uid >= -1;
  if (a.kind === 'exorcise' || a.kind === 'transform')
    return Number.isInteger(a.uid) && a.uid >= 0;
  if (a.kind === 'banishGhost')
    return ['red','blue','green','purple','gold'].includes(a.color);
  if (a.kind === 'npcTool') return
    c.id === c.room.hostId &&
    ['banHammer','kickHammer','freezeHammer','shrinkHammer',
     'cloneHammer','zapHammer','bringHammer','cureHammer'].includes(a.tool) &&
    ['npc','monster','redGhost'].includes(a.targetType) &&
    Number.isInteger(a.uid);
  return false;
}

function validVec(v) {
  return Array.isArray(v) && v.length === 3 &&
    v.every(x => typeof x === 'number' &&
      Number.isFinite(x) && Math.abs(x) < 300);
}

function validPose(p) {
  return p && validVec(p.head) &&
    Number.isFinite(p.yaw) && Math.abs(p.yaw) < 100000 &&
    (!p.left || validVec(p.left)) &&
    (!p.right || validVec(p.right)) &&
    typeof p.vr === 'boolean';
}

function handle(c, m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return;

  if (m.type === 'resume') {
    resume(c, m);
    return;
  }
  if (m.type === 'create') {
    if (c.room || rooms.size >= MAX_ROOMS) return;
    const gameId = String(m.gameId || 'PrimateLab');
    if (!games.includes(gameId)) {
      send(c, { type: 'error', message: 'Unknown game.' });
      return;
    }
    c.requestedName = safeName(m.name);
    const code = roomCode();
    const r = {
      code, gameId, seed: crypto.randomInt(1,0xFFFFFFFF),
      members: new Map(), hostId: null,
      latestWorld: null, seq: 0
    };
    rooms.set(code, r);
    join(c, r);
    return;
  }
  if (m.type === 'join') {
    if (c.room) return;
    const code = String(m.code || '').toUpperCase()
      .replace(/[^A-Z0-9]/g, '').slice(0,6);
    const r = rooms.get(code);
    if (!r) {
      send(c, {
        type: 'error', code: 'ROOM_EXPIRED',
        message: 'Room not found. Server may have restarted.'
      });
      return;
    }
    if (r.gameId !== String(m.gameId || 'PrimateLab')) {
      send(c, { type: 'error', message: 'Wrong game for room.' });
      return;
    }
    c.requestedName = safeName(m.name);
    join(c, r);
    return;
  }
  if (m.type === 'leave') {
    leave(c);
    send(c, { type: 'left' });
    return;
  }
  if (!c.room) return;
  const r = c.room;

  if (m.type === 'pose') {
    if (now() - c.lastPose < 36 || !validPose(m.pose)) return;
    c.lastPose = now();
    c.pose = {
      head: m.pose.head.map(v => Math.round(v*100)/100),
      yaw: m.pose.yaw,
      vr: m.pose.vr,
      left: m.pose.left || null,
      right: m.pose.right || null,
      scene: m.pose.scene || 'lab',
      level: m.pose.level || 0
    };
  } else if (m.type === 'world') {
    if (c.id !== r.hostId || now() - c.lastWorld < 65) return;
    const w = m.world;
    if (!w || typeof w !== 'object' || Array.isArray(w)) return;
    if (r.gameId === 'PrimateLab') {
      if (!Array.isArray(w.scientists) ||
          !Array.isArray(w.monsters) ||
          !Array.isArray(w.ghosts) ||
          w.scientists.length > 40 ||
          w.monsters.length > 45 ||
          w.ghosts.length > 6) return;
    } else if (r.gameId === 'CarnivalHorror') {
      if (!['carnival','falling','backrooms','dead','win']
          .includes(w.scene) ||
          !Number.isInteger(w.level) ||
          w.level < 0 || w.level > 2 ||
          !Array.isArray(w.enemies) || w.enemies.length > 32 ||
          !Array.isArray(w.keys) || w.keys.length > 3) return;
    }
    c.lastWorld = now();
    r.latestWorld = w;
    r.seq++;
    broadcast(r, { type: 'world', world: w, seq: r.seq }, c.id);
  } else if (m.type === 'action') {
    if (now() - c.actionWindow > 1000) {
      c.actionWindow = now();
      c.actionCount = 0;
    }
    if (++c.actionCount > 16 ||
        !allowedAction(c, m.action)) return;
    if (c.id !== r.hostId) {
      const host = r.members.get(r.hostId);
      if (host && !host.closed)
        send(host, {
          type: 'action', from: c.id, action: m.action
        });
    }
  } else if (m.type === 'catch') {
    if (c.id !== r.hostId) return;
    const target = r.members.get(String(m.target || ''));
    if (target && !target.closed)
      send(target, {
        type: 'catch',
        color: ['red','blue','green','purple','gold']
          .includes(m.color) ? m.color : 'red'
      });
  }
}

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path !== '/socket') {
    socket.destroy();
    return;
  }
  if (clients.size >= MAX_ROOMS * MAX_PLAYERS) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' ||
      Buffer.from(key,'base64').length !== 16) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1')
    .update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const c = {
    id: crypto.randomBytes(6).toString('hex'),
    socket, closed:false, disconnectedAt:0,
    resumeToken:null, buffer:Buffer.alloc(0),
    room:null, pose:null, name:'PLAYER',
    requestedName:'PLAYER', color:colors[0],
    lastPose:0, lastWorld:0,
    actionCount:0, actionWindow:0, lastSeen:now()
  };
  clients.add(c);
  send(c, {
    type:'hello', id:c.id, protocol:13,
    maxPlayers:MAX_PLAYERS, games
  });

  const close = () => {
    if (c.closed) return;
    c.closed = true;
    clients.delete(c);
    if (c.room) {
      c.disconnectedAt = now();
      updateRoster(c.room);
    }
    try { socket.destroy(); } catch (_) {}
  };
  socket.on('error', close);
  socket.on('close', close);
  socket.on('end', close);

  function parse() {
    while (c.buffer.length >= 2) {
      const b = c.buffer;
      const op = b[0] & 15;
      const fin = !!(b[0] & 128);
      const masked = !!(b[1] & 128);
      let size = b[1] & 127;
      let off = 2;
      if (size === 126) {
        if (b.length < 4) return;
        size = b.readUInt16BE(2);
        off = 4;
      } else if (size === 127) {
        if (b.length < 10) return;
        const v = b.readBigUInt64BE(2);
        if (v > BigInt(MAX_MESSAGE)) { close(); return; }
        size = Number(v);
        off = 10;
      }
      if (!masked || size > MAX_MESSAGE || !fin) {
        close();
        return;
      }
      if (b.length < off + 4 + size) return;
      const mask = b.subarray(off,off+4);
      const data = Buffer.from(b.subarray(off+4,off+4+size));
      for (let i=0;i<data.length;i++)
        data[i] ^= mask[i%4];
      c.buffer = b.subarray(off+4+size);
      c.lastSeen = now();

      if (op === 8) { frame(c,8); close(); return; }
      if (op === 9) { frame(c,10,data); continue; }
      if (op === 10) continue;
      if (op !== 1) { close(); return; }

      try {
        handle(c, JSON.parse(data.toString('utf8')));
      } catch (_) {}
    }
  }

  socket.on('data', chunk => {
    if (c.closed) return;
    c.buffer = Buffer.concat([c.buffer,chunk]);
    if (c.buffer.length > MAX_MESSAGE + 1024) {
      close();
      return;
    }
    parse();
  });
  if (head?.length) socket.emit('data',head);
});

setInterval(() => {
  for (const c of clients) {
    if (now() - c.lastSeen > 120000) {
      c.socket.destroy();
      continue;
    }
    frame(c,9);
  }
}, 10000);

setInterval(() => {
  const t = now();
  for (const r of rooms.values()) {
    for (const c of [...r.members.values()]) {
      if (c.closed && c.disconnectedAt &&
          t - c.disconnectedAt > GRACE) {
        r.members.delete(c.id);
        c.room = null;
      }
    }
    if (!r.members.size) {
      rooms.delete(r.code);
      continue;
    }
    const h = r.members.get(r.hostId);
    if (!h || (h.closed && h.disconnectedAt &&
               t - h.disconnectedAt > 12000)) {
      const next = [...r.members.values()].find(c => !c.closed);
      if (next && next.id !== r.hostId) {
        r.hostId = next.id;
        broadcast(r, {
          type:'notice',
          message:'Host disconnected. World control transferred.'
        });
      }
    }
  }
}, 1000);

setInterval(() => {
  for (const r of rooms.values())
    updateRoster(r);
}, 100);

function shutdown() {
  for (const c of clients) {
    send(c, { type:'notice', message:'Server restarting' });
    c.socket.destroy();
  }
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(
    `Titanic Kid Plays multiplayer V2 on port ${PORT}`
  );
});
