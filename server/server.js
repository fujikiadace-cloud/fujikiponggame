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

function send(ws, obj){ if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj){ for (const role of ["T","B"]){ const ws = room.players[role]; if (ws) send(ws, obj); } }

function createRoom(code){
  return {
    code,
    players: { T: null, B: null },
    chars: { T: 0, B: 1 },
    started: false,
    serving: "B",
    s: {
      mode: "ready",
      scoreT: 0, scoreB: 0,
      paddleT: 0.5, paddleB: 0.5,
      ballX: 0.5, ballY: 0.5,
      ballR: 0.012,
      vx: 0, vy: 0,
      spin: 0,
      gaugeT: 0, gaugeB: 0,
      armedT: false, armedB: false,
      winner: null
    },
    input: { T: { x: 0.5 }, B: { x: 0.5 } },
  };
}

const rooms = new Map();
const meta = new Map();

function roomInfo(room, youRole){
  const otherRole = youRole === "T" ? "B" : "T";
  return {
    t: "room",
    room: room.code,
    role: youRole,
    otherPresent: !!room.players[otherRole],
    canStart: !!room.players.T && !!room.players.B && !room.started,
    otherChar: room.players[otherRole] ? room.chars[otherRole] : undefined,
  };
}

function resetRound(room, serving){
  const s = room.s;
  s.mode = "ready";
  s.ballX = 0.5; s.ballY = 0.5;
  s.vx = 0; s.vy = 0; s.spin = 0;
  s.armedT = false; s.armedB = false;
  room.serving = serving;
}
function serve(room){
  const s = room.s;
  s.mode = "play";
  const vySign = (room.serving === "T") ? 1 : -1;
  const speed = 0.46 + (s.scoreT + s.scoreB) * 0.012;
  const angle = rand(-0.35, 0.35);
  s.vx = Math.sin(angle) * speed;
  s.vy = Math.cos(angle) * speed * vySign;
  s.spin = 0;
}
function score(room, side){
  const s = room.s;
  if (side === "T") s.scoreT++; else s.scoreB++;
  if (s.scoreT >= 7 || s.scoreB >= 7){
    s.mode = "win";
    s.winner = (s.scoreT > s.scoreB) ? "T" : "B";
    room.started = true;
    return;
  }
  resetRound(room, side);
  serve(room);
}

function applySpecial(room, role){
  const s = room.s;
  if (role === "T"){
    if (s.gaugeT < 1) return false;
    s.gaugeT = 0; s.armedT = true; return true;
  } else {
    if (s.gaugeB < 1) return false;
    s.gaugeB = 0; s.armedB = true; return true;
  }
}

function stepRoom(room){
  const s = room.s;
  if (!room.started) return;
  if (s.mode !== "play") return;

  s.paddleT = clamp(room.input.T.x, 0, 1);
  s.paddleB = clamp(room.input.B.x, 0, 1);

  s.ballX += s.vx * DT;
  s.ballY += s.vy * DT;

  if (Math.abs(s.spin) > 0.0005){
    s.vx += s.spin * 0.22 * DT;
    s.spin *= 0.985;
  } else s.spin = 0;

  if (s.ballX - s.ballR < 0){ s.ballX = s.ballR; s.vx *= -1; s.spin *= 0.9; }
  if (s.ballX + s.ballR > 1){ s.ballX = 1 - s.ballR; s.vx *= -1; s.spin *= 0.9; }

  const paddleHalfW = 0.16;
  const hitZone = (pX) => (s.ballX > pX - paddleHalfW && s.ballX < pX + paddleHalfW);

  const pTy = 0.08, pBy = 0.92, pH = 0.012;

  function bounceFrom(role){
    const pX = (role === "T") ? s.paddleT : s.paddleB;
    const rel = clamp((s.ballX - pX) / paddleHalfW, -1, 1);

    if (role === "T") s.gaugeT = clamp(s.gaugeT + 0.14, 0, 1);
    else s.gaugeB = clamp(s.gaugeB + 0.14, 0, 1);

    let speed = Math.min(1.0, Math.hypot(s.vx, s.vy) + 0.02);

    const armed = (role === "T") ? s.armedT : s.armedB;
    if (armed){
      if (role === "T") s.armedT = false; else s.armedB = false;
      speed = Math.min(1.2, speed + 0.22);
      s.spin = clamp(rel * 0.9, -1.6, 1.6);
    } else {
      s.spin = clamp(s.spin * 0.4 + rel * 0.06, -0.6, 0.6);
    }

    const vySign = (role === "T") ? 1 : -1;
    const angle = clamp(rel * 0.9, -1.1, 1.1);
    s.vx = Math.sin(angle) * speed;
    s.vy = Math.cos(angle) * speed * vySign;
  }

  if (s.vy < 0 && s.ballY - s.ballR <= pTy + pH){
    if (hitZone(s.paddleT)){ s.ballY = pTy + pH + s.ballR; bounceFrom("T"); }
  }
  if (s.vy > 0 && s.ballY + s.ballR >= pBy - pH){
    if (hitZone(s.paddleB)){ s.ballY = pBy - pH - s.ballR; bounceFrom("B"); }
  }

  if (s.ballY < -0.08) score(room, "B");
  if (s.ballY > 1.08) score(room, "T");
}

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
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = req.url.split("?")[0];
  if (pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function leave(ws){
  const me = meta.get(ws);
  if (!me || !me.room) return;
  const room = me.room;
  const role = me.role;
  if (room.players[role] === ws) room.players[role] = null;
  me.room = null; me.role = null;

  for (const r of ["T","B"]){
    const p = room.players[r];
    if (p) send(p, roomInfo(room, r));
  }
  if (!room.players.T && !room.players.B) rooms.delete(room.code);
}

wss.on("connection", (ws) => {
  meta.set(ws, { room: null, role: null });
  send(ws, { t: "info", msg: "connected" });

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    const me = meta.get(ws);

    if (m.t === "create"){
      if (me.room) leave(ws);
      let code = makeCode();
      while (rooms.has(code)) code = makeCode();
      const room = createRoom(code);
      rooms.set(code, room);

      room.players.T = ws;
      me.room = room; me.role = "T";
      room.chars.T = clamp((m.c|0)||0, 0, 2);
      resetRound(room, "B");

      send(ws, roomInfo(room, "T"));
      return;
    }

    if (m.t === "join"){
      if (me.room) leave(ws);
      const code = String(m.room || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, {t:"info", msg:"部屋が見つかりません"}); return; }

      let role = null;
      if (!room.players.T) role = "T";
      else if (!room.players.B) role = "B";
      else { send(ws, {t:"info", msg:"部屋が満員です"}); return; }

      room.players[role] = ws;
      me.room = room; me.role = role;
      room.chars[role] = clamp((m.c|0)||0, 0, 2);

      for (const r of ["T","B"]){
        const p = room.players[r];
        if (p) send(p, roomInfo(room, r));
      }
      const other = role === "T" ? "B" : "T";
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
      const other = me.role === "T" ? "B" : "T";
      const otherWs = me.room.players[other];
      if (otherWs) send(otherWs, {t:"other_char", c: me.room.chars[me.role]});
      return;
    }

    if (m.t === "start"){
      if (!me.room) return;
      const room = me.room;
      if (!room.players.T || !room.players.B) { send(ws, {t:"info", msg:"相手が入室していません"}); return; }
      room.started = true;
      room.s.scoreT = 0; room.s.scoreB = 0;
      room.s.gaugeT = 0; room.s.gaugeB = 0;
      room.s.winner = null;
      resetRound(room, "B");
      serve(room);
      broadcast(room, {t:"start_ok"});
      return;
    }

    if (m.t === "rematch"){
      if (!me.room) return;
      const room = me.room;
      if (!room.players.T || !room.players.B) return;
      room.started = true;
      room.s.scoreT = 0; room.s.scoreB = 0;
      room.s.gaugeT = 0; room.s.gaugeB = 0;
      room.s.winner = null;
      resetRound(room, "B");
      serve(room);
      broadcast(room, {t:"start_ok"});
      return;
    }

    if (m.t === "input"){
      if (!me.room || !me.role) return;
      me.room.input[me.role].x = clamp(Number(m.x), 0, 1);
      return;
    }

    if (m.t === "special"){
      if (!me.room || !me.role) return;
      applySpecial(me.room, me.role);
      return;
    }
  });

  ws.on("close", () => { leave(ws); meta.delete(ws); });
});

setInterval(() => {
  for (const room of rooms.values()){
    stepRoom(room);
    broadcast(room, { t:"state", s: {
      mode: room.s.mode,
      scoreT: room.s.scoreT, scoreB: room.s.scoreB,
      paddleT: room.s.paddleT, paddleB: room.s.paddleB,
      ballX: room.s.ballX, ballY: room.s.ballY,
      ballR: room.s.ballR,
      gaugeT: room.s.gaugeT, gaugeB: room.s.gaugeB,
      armedT: room.s.armedT, armedB: room.s.armedB,
      winner: room.s.winner
    }});
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`Server running: http://0.0.0.0:${PORT}/  (WS: /ws)`);
});
