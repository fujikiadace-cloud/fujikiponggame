/**
 * BrainRod PingPong Duel - One-URL server
 * - Serves static files from ../public
 * - WebSocket endpoint at /ws on SAME origin/port
 *
 * Run:
 *   cd server
 *   npm i
 *   npm start
 *
 * Open:
 *   http://<server-ip>:8787/
 * (Same URL on two phones, then room code)
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const rand = (a,b)=>a+Math.random()*(b-a);
const makeCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
};

function send(ws, obj){
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj){
  for (const role of ["L","R"]){
    const ws = room.players[role];
    if (ws) send(ws, obj);
  }
}

function createRoom(code){
  return {
    code,
    players: { L: null, R: null },
    chars: { L: 0, R: 1 },
    started: false,
    serving: "R",
    s: {
      mode: "ready",
      scoreL: 0, scoreR: 0,
      paddleL: 0.5, paddleR: 0.5,
      ballX: 0.5, ballY: 0.5,
      ballR: 0.014,
      vx: 0, vy: 0,
      spin: 0,
      gaugeL: 0, gaugeR: 0,
      specialL: false, specialR: false,
      winner: null,
    },
    input: { L: { y: 0.5 }, R: { y: 0.5 } },
  };
}

const rooms = new Map(); // code -> room
const meta = new Map();  // ws -> { room, role }

function roomInfo(room, youRole){
  const otherRole = youRole === "L" ? "R" : "L";
  return {
    t: "room",
    room: room.code,
    role: youRole,
    otherPresent: !!room.players[otherRole],
    canStart: !!room.players.L && !!room.players.R && !room.started,
    otherChar: room.players[otherRole] ? room.chars[otherRole] : undefined,
  };
}

function resetRound(room, serving){
  const s = room.s;
  s.mode = "ready";
  s.ballX = 0.5; s.ballY = 0.5;
  s.vx = 0; s.vy = 0; s.spin = 0;
  s.specialL = false; s.specialR = false;
  room.serving = serving;
}

function serve(room){
  const s = room.s;
  s.mode = "play";
  const dir = (room.serving === "L") ? 1 : -1;
  const speed = 0.42 + (s.scoreL + s.scoreR) * 0.012;
  const angle = rand(-0.28, 0.28);
  s.vx = Math.cos(angle) * speed * dir;
  s.vy = Math.sin(angle) * speed;
  s.spin = 0;
}

function score(room, side){
  const s = room.s;
  if (side === "L") s.scoreL++; else s.scoreR++;
  if (s.scoreL >= 7 || s.scoreR >= 7){
    s.mode = "win";
    s.winner = (s.scoreL > s.scoreR) ? "L" : "R";
    room.started = true;
    return;
  }
  resetRound(room, side);
}

function applySpecial(room, role){
  const s = room.s;
  if (role === "L"){
    if (s.gaugeL < 1) return false;
    s.gaugeL = 0; s.specialL = true; return true;
  } else {
    if (s.gaugeR < 1) return false;
    s.gaugeR = 0; s.specialR = true; return true;
  }
}

function stepRoom(room){
  const s = room.s;
  if (!room.started) return;
  if (s.mode === "ready"){
    // auto-serve shortly after start (optional)
    // keep in ready until someone moves? We'll allow manual serve via first movement? For simplicity, auto serve after 0.4s
  }
  if (s.mode !== "play") return;

  s.paddleL = clamp(room.input.L.y, 0, 1);
  s.paddleR = clamp(room.input.R.y, 0, 1);

  s.ballX += s.vx * DT;
  s.ballY += s.vy * DT;

  if (Math.abs(s.spin) > 0.0005){
    s.vy += s.spin * 0.22 * DT;
    s.spin *= 0.985;
  } else s.spin = 0;

  if (s.ballY - s.ballR < 0){
    s.ballY = s.ballR; s.vy *= -1; s.spin *= 0.9;
  }
  if (s.ballY + s.ballR > 1){
    s.ballY = 1 - s.ballR; s.vy *= -1; s.spin *= 0.9;
  }

  const paddleHalfH = 0.13;
  const hitZone = (pY) => (s.ballY > pY - paddleHalfH && s.ballY < pY + paddleHalfH);
  const pLX = 0.08, pRX = 0.92, pW = 0.012;

  function bounceFrom(role){
    const pY = (role === "L") ? s.paddleL : s.paddleR;
    const rel = clamp((s.ballY - pY) / paddleHalfH, -1, 1);

    if (role === "L") s.gaugeL = clamp(s.gaugeL + 0.14, 0, 1);
    else s.gaugeR = clamp(s.gaugeR + 0.14, 0, 1);

    let speed = Math.min(0.95, Math.hypot(s.vx, s.vy) + 0.02);

    const armed = (role === "L") ? s.specialL : s.specialR;
    if (armed){
      if (role === "L") s.specialL = false; else s.specialR = false;
      speed = Math.min(1.15, speed + 0.22);
      s.spin = clamp(rel * 0.9, -1.6, 1.6);
    } else {
      s.spin = clamp(s.spin * 0.4 + rel * 0.06, -0.6, 0.6);
    }

    const sign = (role === "L") ? 1 : -1;
    const angle = clamp(rel * 0.9, -1.1, 1.1);
    s.vx = Math.cos(angle) * speed * sign;
    s.vy = Math.sin(angle) * speed;
  }

  if (s.vx < 0 && s.ballX - s.ballR <= pLX + pW){
    if (hitZone(s.paddleL)){ s.ballX = pLX + pW + s.ballR; bounceFrom("L"); }
  }
  if (s.vx > 0 && s.ballX + s.ballR >= pRX - pW){
    if (hitZone(s.paddleR)){ s.ballX = pRX - pW - s.ballR; bounceFrom("R"); }
  }

  if (s.ballX < -0.08) score(room, "R");
  if (s.ballX > 1.08) score(room, "L");
}

// basic static file server
function serveFile(req, res){
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    const ext = path.extname(filePath).toLowerCase();
    const ct = ext === ".html" ? "text/html; charset=utf-8"
            : ext === ".js" ? "text/javascript; charset=utf-8"
            : ext === ".png" ? "image/png"
            : "application/octet-stream";
    res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(serveFile);

// WebSocket on /ws
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = req.url.split("?")[0];
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  meta.set(ws, { room: null, role: null });
  send(ws, { t:"info", msg:"connected" });

  ws.on("message", (data) => {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    const me = meta.get(ws);

    if (m.t === "create"){
      if (me.room) leave(ws);
      let code = makeCode();
      while (rooms.has(code)) code = makeCode();
      const room = createRoom(code);
      rooms.set(code, room);

      room.players.L = ws;
      me.room = room; me.role = "L";
      room.chars.L = clamp((m.c|0)||0, 0, 2);
      resetRound(room, "R");

      send(ws, roomInfo(room, "L"));
      return;
    }

    if (m.t === "join"){
      if (me.room) leave(ws);
      const code = String(m.room || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, {t:"info", msg:"部屋が見つかりません"}); return; }

      let role = null;
      if (!room.players.L) role = "L";
      else if (!room.players.R) role = "R";
      else { send(ws, {t:"info", msg:"部屋が満員です"}); return; }

      room.players[role] = ws;
      me.room = room; me.role = role;
      room.chars[role] = clamp((m.c|0)||0,0,2);

      for (const r of ["L","R"]){
        const p = room.players[r];
        if (p) send(p, roomInfo(room, r));
      }
      const other = role === "L" ? "R" : "L";
      const otherWs = room.players[other];
      if (otherWs) {
        send(ws, {t:"other_char", c: room.chars[other]});
        send(otherWs, {t:"other_char", c: room.chars[role]});
      }
      return;
    }

    if (m.t === "leave"){ leave(ws); return; }

    if (m.t === "char"){
      if (!me.room || !me.role) return;
      me.room.chars[me.role] = clamp(m.c|0,0,2);
      const other = me.role === "L" ? "R" : "L";
      const otherWs = me.room.players[other];
      if (otherWs) send(otherWs, {t:"other_char", c: me.room.chars[me.role]});
      return;
    }

    if (m.t === "start"){
      if (!me.room) return;
      const room = me.room;
      if (!room.players.L || !room.players.R) { send(ws, {t:"info", msg:"相手が入室していません"}); return; }
      room.started = true;
      // reset match
      room.s.scoreL = 0; room.s.scoreR = 0;
      room.s.gaugeL = 0; room.s.gaugeR = 0;
      room.s.winner = null;
      resetRound(room, "R");
      serve(room); // auto-serve immediately
      broadcast(room, {t:"start_ok"});
      return;
    }

    if (m.t === "rematch"){
      if (!me.room) return;
      const room = me.room;
      if (!room.players.L || !room.players.R) return;
      room.started = true;
      room.s.scoreL = 0; room.s.scoreR = 0;
      room.s.gaugeL = 0; room.s.gaugeR = 0;
      room.s.winner = null;
      resetRound(room, "R");
      serve(room);
      broadcast(room, {t:"start_ok"});
      return;
    }

    if (m.t === "input"){
      if (!me.room || !me.role) return;
      me.room.input[me.role].y = clamp(Number(m.y), 0, 1);
      return;
    }

    if (m.t === "special"){
      if (!me.room || !me.role) return;
      applySpecial(me.room, me.role);
      return;
    }
  });

  ws.on("close", () => {
    leave(ws);
    meta.delete(ws);
  });
});

function leave(ws){
  const me = meta.get(ws);
  if (!me || !me.room) return;
  const room = me.room;
  const role = me.role;

  if (room.players[role] === ws) room.players[role] = null;
  me.room = null; me.role = null;

  for (const r of ["L","R"]){
    const p = room.players[r];
    if (p) send(p, roomInfo(room, r));
  }

  if (!room.players.L && !room.players.R){
    rooms.delete(room.code);
  }
}

setInterval(() => {
  for (const room of rooms.values()){
    stepRoom(room);
    broadcast(room, { t:"state", s: {
      mode: room.s.mode,
      scoreL: room.s.scoreL, scoreR: room.s.scoreR,
      paddleL: room.s.paddleL, paddleR: room.s.paddleR,
      ballX: room.s.ballX, ballY: room.s.ballY,
      ballR: room.s.ballR,
      spin: room.s.spin,
      gaugeL: room.s.gaugeL, gaugeR: room.s.gaugeR,
      specialL: room.s.specialL, specialR: room.s.specialR,
      winner: room.s.winner
    }});
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`Server running: http://0.0.0.0:${PORT}/  (WS: /ws)`);
});
