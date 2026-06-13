/* =========================================================================
   VoiceMatch Server v6
   - Fixes: peer-mute sync, queue-lock prevents re-joining while in call
   - Admin: editable homepage stats, kill-call, ban-IP, real-time charts,
            queue inspector, interest heatmap, broadcast message
   ========================================================================= */

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { Server } = require('socket.io');

const PORT         = 3000;
const ADMIN_SECRET = 'vm_admin_x9k2p7';

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.ico':'image/x-icon','.mp3':'audio/mpeg','.mpeg':'audio/mpeg',
};

// ── In-memory store ─────────────────────────────────────────────
const callLog     = [];
const activeCalls = {};
const reportLog   = [];
const bannedIPs   = new Set();
let totalConnections = 0;
let totalMatches     = 0;

// Editable homepage stats (admin can change these)
let homepageStats = { activeUsers:'12.4K', avgMatch:'3.2s', anonymous:'98%', uptime:'24/7' };

// Broadcast message shown to all users (empty = none)
let broadcastMsg = '';

// ── IP helper ───────────────────────────────────────────────────
function getIp(req) {
  return (req.headers['x-forwarded-for']||'').split(',')[0].trim()
      || req.socket?.remoteAddress || 'unknown';
}

// ── HTTP server ─────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const ip = getIp(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }

  // ── /admin ───────────────────────────────────────────────────
  if (req.url === '/admin' || req.url.startsWith('/admin?')) {
    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get('key');
    if (key !== ADMIN_SECRET) {
      res.writeHead(403,{'Content-Type':'text/html'});
      res.end(`<!DOCTYPE html><html><head><title>Admin</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#04050e;color:#e8eaff;font-family:'Space Grotesk',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.box{background:#0b0d1a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;width:340px;text-align:center}
h2{font-size:18px;margin-bottom:6px;color:#fff}p{font-size:12px;color:rgba(200,208,255,0.5);margin-bottom:24px}
input{width:100%;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:#14182c;color:#e8eaff;font-size:13px;outline:none;margin-bottom:12px}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#6378ff;color:#fff;font-weight:700;font-size:12px;cursor:pointer;letter-spacing:1px}
button:hover{background:#7b8fff}</style></head><body>
<div class="box"><h2>VoiceMatch Admin</h2><p>Enter your admin key to continue</p>
<form method="GET" action="/admin"><input type="password" name="key" placeholder="Admin key" autofocus>
<button type="submit">ACCESS PANEL</button></form></div></body></html>`);
      return;
    }
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(buildAdminHtml());
    return;
  }

  // ── /admin-api ───────────────────────────────────────────────
  if (req.url.startsWith('/admin-api/')) {
    const url = new URL(req.url,'http://localhost');
    if (url.searchParams.get('key') !== ADMIN_SECRET) { res.writeHead(403); res.end('Forbidden'); return; }

    // POST actions
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const ep = req.url.split('?')[0];

          if (ep === '/admin-api/update-stats') {
            if (payload.activeUsers !== undefined) homepageStats.activeUsers = String(payload.activeUsers);
            if (payload.avgMatch    !== undefined) homepageStats.avgMatch    = String(payload.avgMatch);
            if (payload.anonymous   !== undefined) homepageStats.anonymous   = String(payload.anonymous);
            if (payload.uptime      !== undefined) homepageStats.uptime      = String(payload.uptime);
            res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
            res.end(JSON.stringify({ok:true,stats:homepageStats}));
            return;
          }

          if (ep === '/admin-api/broadcast') {
            broadcastMsg = payload.message || '';
            io.emit('broadcast-msg', { message: broadcastMsg });
            res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
            res.end(JSON.stringify({ok:true}));
            return;
          }

          if (ep === '/admin-api/kill-call') {
            const roomId = payload.roomId;
            if (roomId && activeCalls[roomId]) {
              io.to(roomId).emit('lab-signal',{peerDisconnectedSignal:true,reason:'admin'});
              const peers = Object.entries(activeRoomsMap).filter(([,r])=>r===roomId).map(([id])=>id);
              cleanRoom(roomId, peers);
              res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
              res.end(JSON.stringify({ok:true}));
            } else {
              res.writeHead(404,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
              res.end(JSON.stringify({ok:false,error:'Room not found'}));
            }
            return;
          }

          if (ep === '/admin-api/ban-ip') {
            bannedIPs.add(payload.ip);
            res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
            res.end(JSON.stringify({ok:true,banned:[...bannedIPs]}));
            return;
          }

          if (ep === '/admin-api/unban-ip') {
            bannedIPs.delete(payload.ip);
            res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
            res.end(JSON.stringify({ok:true,banned:[...bannedIPs]}));
            return;
          }

        } catch(e) { res.writeHead(400); res.end('Bad request'); }
      });
      return;
    }

    // GET data
    const interestFreq = {};
    [...Object.values(pendingInterests), ...callLog.map(c=>c.interestsA||[]), ...callLog.map(c=>c.interestsB||[])].flat().forEach(i=>{interestFreq[i]=(interestFreq[i]||0)+1;});

    const data = {
      calls:    callLog.slice(-200).reverse(),
      active:   Object.values(activeCalls),
      reports:  reportLog.slice(-200).reverse(),
      queue:    Object.values(matchingPool),
      bannedIPs:[...bannedIPs],
      homepageStats,
      broadcastMsg,
      stats: {
        totalConnections, totalMatches,
        activeCalls: Object.keys(activeCalls).length,
        queueSize:   Object.keys(matchingPool).length,
        totalReports:  reportLog.length,
        totalCallsLog: callLog.length,
        avgDuration: callLog.length ? Math.round(callLog.reduce((a,c)=>a+(c.durationSec||0),0)/callLog.length) : 0,
        interestFreq,
      }
    };
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(data));
    return;
  }

  // ── /api/report ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/report') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { socketId, targetSid, roomId, reason, description } = JSON.parse(body);
        reportLog.push({ ts:new Date().toISOString(), reporterIp:ip, reporterSid:socketId, targetSid:targetSid||'unknown', roomId:roomId||'unknown', reason, description:description||'' });
        console.log(`[Report] ${reason} | room:${roomId}`);
        res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ok:true}));
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  // ── /api/matchmake ───────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/matchmake') {
    if (bannedIPs.has(ip)) { res.writeHead(403); res.end('Banned'); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { socketId } = JSON.parse(body);
        if (socketIpMap[socketId] === undefined) socketIpMap[socketId] = ip;
        // FIX #6: If socket is already in a call, reject matchmaking
        if (activeRoomsMap[socketId]) {
          res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({action:'already_in_call', roomId:activeRoomsMap[socketId]}));
          return;
        }
        const result = processMatchmake(socketId);
        res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(400); res.end('Bad request'); }
    });
    return;
  }

  // ── /api/homepage-stats ───────────────────────────────────────
  if (req.url === '/api/homepage-stats') {
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(homepageStats));
    return;
  }

  // ── Static files ─────────────────────────────────────────────
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  urlPath = urlPath.split('?')[0];
  const filePath = path.join(__dirname,'frontend',urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath,(err,data)=>{
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'});
    res.end(data);
  });
});

const io = new Server(httpServer,{cors:{origin:'*'}});

let matchingPool   = {};
let activeRoomsMap = {};
let roomTimers     = {};
const roomState    = {};
const pendingInterests = {};
const socketIpMap  = {};

function doMatch(idA, idB, roomId) {
  const sockA = io.sockets.sockets.get(idA);
  const sockB = io.sockets.sockets.get(idB);
  if (sockA) sockA.join(roomId);
  if (sockB) sockB.join(roomId);
  activeRoomsMap[idA] = roomId;
  activeRoomsMap[idB] = roomId;

  const firstQ = Math.floor(Math.random()*50);
  roomState[roomId] = {
    questionIndex: firstQ, turnSocketId: idA,
    members: [idA,idB], skipVotes: new Set(), questionsShown:[firstQ],
  };
  activeCalls[roomId] = {
    roomId, startTs:new Date().toISOString(),
    peerA:{sid:idA,ip:socketIpMap[idA]||'unknown'},
    peerB:{sid:idB,ip:socketIpMap[idB]||'unknown'},
    questionsShown:[firstQ],
    interestsA:pendingInterests[idA]||[],
    interestsB:pendingInterests[idB]||[],
  };
  totalMatches++;

  // 60 minute call timeout
  roomTimers[roomId] = setTimeout(()=>{
    if (activeRoomsMap[idA]===roomId || activeRoomsMap[idB]===roomId) {
      io.to(roomId).emit('lab-signal',{peerDisconnectedSignal:true,reason:'timeout'});
      cleanRoom(roomId,[idA,idB]);
    }
  }, 3600000);

  console.log(`[Match] ${idA.slice(0,6)} + ${idB.slice(0,6)} | ${roomId}`);
}

function processMatchmake(socketId) {
  delete matchingPool[socketId];
  const interests = pendingInterests[socketId]||[];
  delete pendingInterests[socketId];

  const waiting = Object.values(matchingPool).filter(u=>u.source==='http');
  if (waiting.length === 0) {
    matchingPool[socketId] = {id:socketId,interests,source:'http'};
    return {action:'wait', roomId:`room_${socketId}_pending`};
  }
  let bestPeer=waiting[0],bestScore=-1;
  for (const peer of waiting) {
    const score = interests.filter(i=>peer.interests.includes(i)).length;
    if (score>bestScore){bestScore=score;bestPeer=peer;}
  }
  delete matchingPool[bestPeer.id];
  const roomId=`room_${bestPeer.id}_${socketId}`;
  doMatch(bestPeer.id,socketId,roomId);
  const sockA=io.sockets.sockets.get(bestPeer.id);
  if (sockA) sockA.emit('peer-ready',{roomId,role:'A'});
  return {action:'matched',roomId,role:'B'};
}

io.on('connection',(socket)=>{
  totalConnections++;
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
           || socket.handshake.address||'unknown';
  if (bannedIPs.has(ip)) { socket.disconnect(); return; }
  socketIpMap[socket.id]=ip;
  console.log(`[Connect] ${socket.id} [${ip}]`);

  // Send broadcast if active
  if (broadcastMsg) socket.emit('broadcast-msg',{message:broadcastMsg});

  socket.on('set-interests',({interests})=>{
    pendingInterests[socket.id]=Array.isArray(interests)?interests:[];
  });

  socket.on('join-queue',({interests})=>{
    if (activeRoomsMap[socket.id]) return; // FIX #6: prevent re-queuing while in call
    pendingInterests[socket.id]=Array.isArray(interests)?interests:[];
    delete matchingPool[socket.id];
    const waiting=Object.values(matchingPool).filter(u=>u.source==='socket');
    if (waiting.length===0){
      matchingPool[socket.id]={id:socket.id,interests:pendingInterests[socket.id],source:'socket'};
      socket.emit('match-waiting',{message:'Waiting for a peer...'});
      return;
    }
    const peer=waiting[0];
    delete matchingPool[peer.id];
    delete pendingInterests[socket.id];
    const roomId=`room_${peer.id}_${socket.id}`;
    doMatch(peer.id,socket.id,roomId);
    const peerSock=io.sockets.sockets.get(peer.id);
    if (peerSock) peerSock.emit('match-success',{roomId,role:'A'});
    socket.emit('match-success',{roomId,role:'B'});
  });

  socket.on('lab-signal',(data)=>{
    if (!data.roomId) return;
    if (data.offer&&roomTimers[data.roomId]){clearTimeout(roomTimers[data.roomId]);delete roomTimers[data.roomId];}
    if (data.callLive&&roomState[data.roomId]){
      const rs=roomState[data.roomId];
      io.to(data.roomId).emit('room-state',{questionIndex:rs.questionIndex,turnSocketId:rs.turnSocketId,members:rs.members,skipVotes:[...rs.skipVotes]});
    }
    // FIX #9: relay peer-mute events to other side
    socket.to(data.roomId).emit('lab-signal',data);
  });

  socket.on('skip-vote',({roomId})=>{
    const rs=roomState[roomId]; if(!rs) return;
    rs.skipVotes.add(socket.id);
    io.to(roomId).emit('skip-update',{votes:[...rs.skipVotes],total:2});
    if (rs.skipVotes.size>=2){
      rs.questionIndex=(rs.questionIndex+1)%50;
      rs.skipVotes=new Set(); rs.turnSocketId=socket.id;
      if (rs.questionsShown) rs.questionsShown.push(rs.questionIndex);
      if (activeCalls[roomId]) activeCalls[roomId].questionsShown=rs.questionsShown||[];
      io.to(roomId).emit('room-state',{questionIndex:rs.questionIndex,turnSocketId:rs.turnSocketId,members:rs.members,skipVotes:[]});
    }
  });

  socket.on('disconnect',()=>{
    console.log(`[Disconnect] ${socket.id}`);
    delete matchingPool[socket.id];
    delete pendingInterests[socket.id];
    const assignedRoom=activeRoomsMap[socket.id];
    if (assignedRoom){
      socket.to(assignedRoom).emit('lab-signal',{peerDisconnectedSignal:true,reason:'disconnect'});
      const peers=Object.entries(activeRoomsMap).filter(([,r])=>r===assignedRoom).map(([id])=>id);
      cleanRoom(assignedRoom,peers);
    }
  });
});

function cleanRoom(roomId,peerIds){
  if (activeCalls[roomId]){
    const ac=activeCalls[roomId];
    ac.endTs=new Date().toISOString();
    ac.durationSec=Math.round((new Date(ac.endTs)-new Date(ac.startTs))/1000);
    callLog.push(ac);
    delete activeCalls[roomId];
  }
  peerIds.forEach(id=>delete activeRoomsMap[id]);
  delete roomState[roomId];
  if (roomTimers[roomId]){clearTimeout(roomTimers[roomId]);delete roomTimers[roomId];}
  console.log(`[Clean] Room ${roomId}`);
}

// ── Admin HTML ───────────────────────────────────────────────────
function buildAdminHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VoiceMatch Admin v6</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
:root{--bg:#04050e;--bg1:#070810;--bg2:#0b0d1a;--bg3:#0f1222;--bg4:#14182c;
  --line:rgba(255,255,255,0.055);--line2:rgba(255,255,255,0.1);--a1:#6378ff;--a2:#9b6fff;--a3:#3dcfb8;--a4:#ff6b9d;--a5:#ffd666;
  --txt:#e8eaff;--txt2:rgba(200,208,255,0.52);--txt3:rgba(200,208,255,0.28);
  --gf:'Space Grotesk',sans-serif;--mf:'Space Mono',monospace;--red:#ff5050;--green:#3dcfb8;}
html,body{background:var(--bg);color:var(--txt);font-family:var(--gf);min-height:100vh;}
::-webkit-scrollbar{width:4px;height:4px;}::-webkit-scrollbar-track{background:var(--bg1);}::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:4px;}

/* NAV */
.nav{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;
  border-bottom:1px solid var(--line);background:rgba(4,5,14,0.97);position:sticky;top:0;z-index:100;}
.nav-logo{font-family:var(--mf);font-size:11px;letter-spacing:3px;color:var(--txt);display:flex;align-items:center;gap:8px;}
.logo-dot{width:6px;height:6px;border-radius:50%;background:var(--a1);animation:breathe 2s infinite;}
@keyframes breathe{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.2;transform:scale(0.5);}}
.nav-badge{font-family:var(--mf);font-size:8px;letter-spacing:2px;padding:2px 9px;border-radius:4px;
  background:rgba(255,107,157,0.1);border:1px solid rgba(255,107,157,0.25);color:var(--a4);}
.nav-right{display:flex;align-items:center;gap:10px;}
.refresh-btn{font-family:var(--mf);font-size:9px;letter-spacing:1px;padding:6px 12px;border-radius:6px;
  border:1px solid var(--line2);background:transparent;color:var(--txt2);cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:5px;}
.refresh-btn:hover{border-color:var(--a1);color:var(--a1);}
.live-indicator{display:flex;align-items:center;gap:5px;font-family:var(--mf);font-size:8px;color:var(--a3);letter-spacing:1px;}
.live-dot{width:5px;height:5px;border-radius:50%;background:var(--a3);animation:breathe 1.2s infinite;}
.last-updated{font-family:var(--mf);font-size:8px;color:var(--txt3);letter-spacing:0.5px;}

/* LAYOUT */
.layout{display:flex;height:calc(100vh - 52px);}
.sidebar{width:196px;border-right:1px solid var(--line);flex-shrink:0;padding:16px 0;overflow-y:auto;background:var(--bg1);}
.sb-section{font-family:var(--mf);font-size:8px;letter-spacing:2px;color:var(--txt3);padding:10px 16px 5px;text-transform:uppercase;}
.sb-item{display:flex;align-items:center;gap:9px;padding:9px 16px;cursor:pointer;font-size:11px;
  font-weight:500;color:var(--txt2);letter-spacing:0.2px;transition:all 0.18s;border-left:2px solid transparent;user-select:none;}
.sb-item:hover{background:rgba(99,120,255,0.05);color:var(--txt);border-left-color:rgba(99,120,255,0.25);}
.sb-item.act{background:rgba(99,120,255,0.09);color:var(--a1);border-left-color:var(--a1);}
.sb-item i{font-size:14px;width:16px;text-align:center;}
.sb-badge{margin-left:auto;font-family:var(--mf);font-size:8px;padding:1px 6px;border-radius:4px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.2);color:#ff7070;}
.sb-sep{height:1px;background:var(--line);margin:8px 12px;}

.main{flex:1;overflow-y:auto;padding:24px 28px;}
.tab-panel{display:none;}.tab-panel.act{display:block;}

/* STAT CARDS */
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:24px;}
.stat-card{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:18px 16px;position:relative;}
.stat-card.highlight{border-color:rgba(61,207,184,0.25);}
.sc-val{font-family:var(--mf);font-size:24px;font-weight:700;color:#fff;letter-spacing:-1px;line-height:1;margin-bottom:4px;}
.sc-lbl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--txt3);}
.sc-trend{font-family:var(--mf);font-size:9px;color:var(--a3);margin-top:5px;}
.sc-edit{position:absolute;top:10px;right:10px;background:transparent;border:none;cursor:pointer;color:var(--txt3);font-size:11px;opacity:0;transition:opacity 0.2s;}
.stat-card:hover .sc-edit{opacity:1;}

/* SECTION HEADER */
.sec-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.sec-title{font-size:13px;font-weight:600;color:#fff;letter-spacing:-0.2px;display:flex;align-items:center;gap:8px;}
.sec-title .cnt{font-family:var(--mf);font-size:9px;letter-spacing:1px;color:var(--txt3);padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.04);border:1px solid var(--line);}
.sec-act{display:flex;align-items:center;gap:8px;}
.sec-btn{font-family:var(--mf);font-size:9px;letter-spacing:0.5px;padding:5px 11px;border-radius:6px;border:1px solid var(--line2);background:transparent;color:var(--txt2);cursor:pointer;transition:all 0.2s;display:flex;align-items:center;gap:5px;}
.sec-btn:hover{border-color:var(--a1);color:var(--a1);}
.sec-btn.danger:hover{border-color:var(--red);color:var(--red);}

/* TABLE */
.table-wrap{background:var(--bg2);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:24px;}
table{width:100%;border-collapse:collapse;}
thead tr{background:var(--bg3);border-bottom:1px solid var(--line);}
th{padding:9px 14px;font-family:var(--mf);font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--txt3);text-align:left;font-weight:400;}
td{padding:9px 14px;font-size:11px;color:var(--txt2);border-bottom:1px solid rgba(255,255,255,0.025);}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(99,120,255,0.025);}
.td-mono{font-family:var(--mf);font-size:9px;color:var(--txt3);}
.td-act{display:flex;align-items:center;gap:6px;}

/* BADGES & CHIPS */
.badge{display:inline-flex;align-items:center;font-family:var(--mf);font-size:8px;letter-spacing:1px;padding:2px 7px;border-radius:4px;text-transform:uppercase;}
.badge.green{background:rgba(61,207,184,0.09);border:1px solid rgba(61,207,184,0.2);color:var(--a3);}
.badge.red{background:rgba(255,80,80,0.09);border:1px solid rgba(255,80,80,0.2);color:#ff6060;}
.badge.blue{background:rgba(99,120,255,0.09);border:1px solid rgba(99,120,255,0.2);color:var(--a1);}
.badge.amber{background:rgba(255,170,0,0.09);border:1px solid rgba(255,170,0,0.2);color:#ffaa00;}
.badge.purple{background:rgba(155,111,255,0.09);border:1px solid rgba(155,111,255,0.2);color:var(--a2);}
.ip-chip{font-family:var(--mf);font-size:8px;color:var(--txt3);background:rgba(255,255,255,0.03);border:1px solid var(--line);padding:1px 7px;border-radius:4px;}
.sid-chip{font-family:var(--mf);font-size:9px;color:var(--a2);}
.empty-state{padding:36px;text-align:center;font-family:var(--mf);font-size:10px;color:var(--txt3);letter-spacing:1px;}

/* ACTIVE CALL CARD */
.ac-card{background:var(--bg2);border:1px solid rgba(61,207,184,0.18);border-radius:12px;padding:16px 18px;margin-bottom:8px;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;}
.ac-card:hover{border-color:rgba(61,207,184,0.35);}
.ac-left{flex:1;min-width:0;}
.ac-room{font-family:var(--mf);font-size:9px;color:var(--txt3);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-peers{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.ac-peer{display:flex;flex-direction:column;gap:3px;}
.ac-peer-sid{font-family:var(--mf);font-size:10px;color:var(--a1);}
.ac-peer-ip{font-family:var(--mf);font-size:8px;color:var(--txt3);}
.ac-vs{color:var(--txt3);font-size:11px;font-family:var(--mf);}
.ac-qs{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.ac-q{font-family:var(--mf);font-size:7px;padding:2px 6px;border-radius:4px;background:rgba(61,207,184,0.07);border:1px solid rgba(61,207,184,0.15);color:var(--a3);}
.ac-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0;}
.ac-timer{font-family:var(--mf);font-size:12px;color:var(--a3);letter-spacing:2px;}
.kill-btn{font-family:var(--mf);font-size:8px;letter-spacing:1px;padding:4px 10px;border-radius:5px;
  border:1px solid rgba(255,80,80,0.25);background:rgba(255,80,80,0.05);color:#ff7070;cursor:pointer;transition:all 0.2s;}
.kill-btn:hover{background:rgba(255,80,80,0.12);border-color:rgba(255,80,80,0.5);}

/* QUEUE CARD */
.queue-card{background:var(--bg2);border:1px solid rgba(99,120,255,0.15);border-radius:10px;padding:12px 16px;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;}
.qc-sid{font-family:var(--mf);font-size:10px;color:var(--a1);}
.qc-interests{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}
.qc-int{font-family:var(--mf);font-size:8px;padding:1px 6px;border-radius:4px;background:rgba(99,120,255,0.08);border:1px solid rgba(99,120,255,0.15);color:var(--txt2);}
.qc-wait{font-family:var(--mf);font-size:9px;color:var(--txt3);}

/* INTEREST HEATMAP */
.heatmap{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-bottom:24px;}
.hm-item{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;cursor:default;}
.hm-name{font-size:11px;font-weight:500;color:var(--txt);margin-bottom:6px;}
.hm-bar-wrap{height:3px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden;margin-bottom:4px;}
.hm-bar{height:100%;background:var(--a1);border-radius:3px;transition:width 0.4s;}
.hm-count{font-family:var(--mf);font-size:9px;color:var(--txt3);}

/* BROADCAST */
.broadcast-panel{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:24px;}
.bp-title{font-size:12px;font-weight:600;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.bp-input{width:100%;background:var(--bg3);border:1px solid var(--line2);color:var(--txt);font-family:var(--gf);font-size:12px;padding:10px 14px;border-radius:8px;outline:none;margin-bottom:10px;}
.bp-input:focus{border-color:var(--a1);}
.bp-row{display:flex;gap:8px;}
.bp-send{flex:1;padding:9px;border-radius:8px;border:none;background:var(--a1);color:#fff;font-size:10px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:all 0.2s;}
.bp-send:hover{background:#7b8fff;}
.bp-clear{padding:9px 16px;border-radius:8px;border:1px solid var(--line2);background:transparent;color:var(--txt2);font-size:10px;cursor:pointer;transition:all 0.2s;}
.bp-clear:hover{border-color:var(--red);color:var(--red);}

/* EDIT STATS PANEL */
.edit-stats-panel{background:var(--bg2);border:1px solid rgba(99,120,255,0.2);border-radius:12px;padding:20px;margin-bottom:24px;}
.esp-title{font-size:12px;font-weight:600;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:7px;}
.esp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px;}
.esp-field{display:flex;flex-direction:column;gap:5px;}
.esp-label{font-family:var(--mf);font-size:9px;letter-spacing:1px;color:var(--txt3);text-transform:uppercase;}
.esp-input{background:var(--bg3);border:1px solid var(--line2);color:var(--txt);font-family:var(--mf);font-size:13px;padding:8px 12px;border-radius:7px;outline:none;}
.esp-input:focus{border-color:var(--a1);}
.esp-save{padding:9px 20px;border-radius:8px;border:none;background:var(--a1);color:#fff;font-size:10px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:all 0.2s;}
.esp-save:hover{background:#7b8fff;}

/* BAN LIST */
.ban-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg2);border:1px solid rgba(255,80,80,0.15);border-radius:8px;margin-bottom:6px;}
.ban-ip{font-family:var(--mf);font-size:11px;color:#ff7070;}
.unban-btn{font-family:var(--mf);font-size:8px;letter-spacing:1px;padding:3px 9px;border-radius:5px;border:1px solid rgba(61,207,184,0.2);background:transparent;color:var(--a3);cursor:pointer;transition:all 0.2s;}
.unban-btn:hover{background:rgba(61,207,184,0.08);}

/* MINI CHART */
.mini-chart-wrap{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:24px;}
.mc-title{font-size:11px;font-weight:600;color:#fff;margin-bottom:14px;}
.mini-bars{display:flex;align-items:flex-end;gap:4px;height:60px;}
.mini-bar{flex:1;background:rgba(99,120,255,0.25);border-radius:3px 3px 0 0;min-height:2px;transition:height 0.4s;}
.mini-bar:hover{background:rgba(99,120,255,0.55);}

/* MODAL */
.modal-overlay{position:fixed;inset:0;background:rgba(4,5,14,0.85);backdrop-filter:blur(8px);z-index:900;display:none;align-items:center;justify-content:center;}
.modal-overlay.open{display:flex;}
.modal-box{background:var(--bg2);border:1px solid var(--line2);border-radius:16px;padding:28px;width:100%;max-width:380px;}
.modal-title{font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;}
.modal-sub{font-size:11px;color:var(--txt2);margin-bottom:20px;line-height:1.6;}
.modal-input{width:100%;background:var(--bg3);border:1px solid var(--line2);color:var(--txt);font-family:var(--mf);font-size:12px;padding:9px 12px;border-radius:8px;outline:none;margin-bottom:14px;}
.modal-input:focus{border-color:var(--a1);}
.modal-btns{display:flex;gap:8px;}
.modal-cancel{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--txt2);font-size:11px;cursor:pointer;}
.modal-submit{flex:2;padding:10px;border-radius:8px;border:none;background:var(--a1);color:#fff;font-size:11px;font-weight:700;cursor:pointer;}

/* TOAST */
.a-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg4);border:1px solid var(--line2);color:var(--txt);font-size:11px;padding:9px 20px;border-radius:9px;opacity:0;transition:opacity 0.3s;pointer-events:none;font-family:var(--gf);z-index:999;white-space:nowrap;}
.a-toast.show{opacity:1;}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-logo"><div class="logo-dot"></div>VOICEMATCH / ADMIN</div>
  <div class="nav-right">
    <span class="live-indicator"><div class="live-dot"></div>LIVE</span>
    <span class="last-updated" id="lastUpdated">—</span>
    <button class="refresh-btn" onclick="loadData()"><i class="ti ti-refresh" style="font-size:11px;"></i> Refresh</button>
    <div class="nav-badge">ADMIN ONLY</div>
  </div>
</nav>

<div class="layout">
  <div class="sidebar">
    <div class="sb-section">Overview</div>
    <div class="sb-item act" onclick="switchTab('overview',this)"><i class="ti ti-layout-dashboard"></i>Dashboard</div>
    <div class="sb-item" onclick="switchTab('active',this)"><i class="ti ti-phone"></i>Active Calls <span class="sb-badge" id="sb-active-cnt">0</span></div>
    <div class="sb-item" onclick="switchTab('queue',this)"><i class="ti ti-users"></i>Queue <span class="sb-badge" id="sb-queue-cnt">0</span></div>
    <div class="sb-sep"></div>
    <div class="sb-section">Logs</div>
    <div class="sb-item" onclick="switchTab('calls',this)"><i class="ti ti-history"></i>Call History</div>
    <div class="sb-item" onclick="switchTab('reports',this)"><i class="ti ti-flag"></i>Reports <span class="sb-badge" id="sb-report-cnt" style="display:none">0</span></div>
    <div class="sb-sep"></div>
    <div class="sb-section">Control</div>
    <div class="sb-item" onclick="switchTab('homepage',this)"><i class="ti ti-home"></i>Homepage Stats</div>
    <div class="sb-item" onclick="switchTab('broadcast',this)"><i class="ti ti-speakerphone"></i>Broadcast</div>
    <div class="sb-item" onclick="switchTab('bans',this)"><i class="ti ti-ban"></i>IP Bans</div>
    <div class="sb-item" onclick="switchTab('interests',this)"><i class="ti ti-chart-bar"></i>Interest Data</div>
  </div>

  <div class="main">

    <!-- OVERVIEW -->
    <div class="tab-panel act" id="tab-overview">
      <div class="stats-row" id="statsGrid"></div>
      <div class="sec-hd">
        <div class="sec-title">Active Calls <span class="cnt" id="activeCount">0</span></div>
        <div class="sec-act"><button class="sec-btn" onclick="switchTab('active',document.querySelector('.sb-item:nth-child(3)'))"><i class="ti ti-arrow-right" style="font-size:10px;"></i>See all</button></div>
      </div>
      <div id="activeCallsPreview"></div>
      <div class="sec-hd" style="margin-top:8px;">
        <div class="sec-title">Recent Reports <span class="cnt" id="reportCountOv">0</span></div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>Time</th><th>Reason</th><th>Room</th><th>Reporter IP</th>
      </tr></thead><tbody id="recentReports"></tbody></table></div>
    </div>

    <!-- ACTIVE CALLS -->
    <div class="tab-panel" id="tab-active">
      <div class="sec-hd">
        <div class="sec-title">Live Calls <span class="cnt" id="liveCount2">0</span></div>
        <div class="sec-act">
          <button class="sec-btn danger" onclick="confirmKillAll()"><i class="ti ti-x" style="font-size:10px;"></i>Kill All</button>
        </div>
      </div>
      <div id="activeCallsFull"></div>
    </div>

    <!-- QUEUE -->
    <div class="tab-panel" id="tab-queue">
      <div class="sec-hd">
        <div class="sec-title">Matchmaking Queue <span class="cnt" id="queueCount">0</span></div>
      </div>
      <div id="queueList"></div>
    </div>

    <!-- CALL HISTORY -->
    <div class="tab-panel" id="tab-calls">
      <div class="sec-hd">
        <div class="sec-title">Call History <span class="cnt" id="callHistCount">0</span></div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>#</th><th>Room</th><th>Peer A</th><th>Peer B</th><th>Started</th><th>Duration</th><th>Questions</th>
      </tr></thead><tbody id="callHistBody"></tbody></table></div>
    </div>

    <!-- REPORTS -->
    <div class="tab-panel" id="tab-reports">
      <div class="sec-hd">
        <div class="sec-title">All Reports <span class="cnt" id="allReportCount">0</span></div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>#</th><th>Time</th><th>Reason</th><th>Description</th><th>Room</th><th>Reporter SID</th><th>Reporter IP</th><th>Actions</th>
      </tr></thead><tbody id="allReportsBody"></tbody></table></div>
    </div>

    <!-- HOMEPAGE STATS EDITOR -->
    <div class="tab-panel" id="tab-homepage">
      <div class="edit-stats-panel">
        <div class="esp-title"><i class="ti ti-edit" style="color:var(--a1);font-size:14px;"></i>Edit Homepage Statistics</div>
        <div class="esp-grid">
          <div class="esp-field"><label class="esp-label">Active Users</label><input class="esp-input" id="es-activeUsers" placeholder="e.g. 12.4K"></div>
          <div class="esp-field"><label class="esp-label">Avg Match Time</label><input class="esp-input" id="es-avgMatch" placeholder="e.g. 3.2s"></div>
          <div class="esp-field"><label class="esp-label">Anonymous %</label><input class="esp-input" id="es-anonymous" placeholder="e.g. 98%"></div>
          <div class="esp-field"><label class="esp-label">Uptime</label><input class="esp-input" id="es-uptime" placeholder="e.g. 24/7"></div>
        </div>
        <button class="esp-save" onclick="saveHomepageStats()"><i class="ti ti-check" style="font-size:11px;"></i> Save & Push Live</button>
      </div>
      <div class="mini-chart-wrap">
        <div class="mc-title">Call Volume (last 10 logged calls — bar = duration in seconds)</div>
        <div class="mini-bars" id="miniChart"></div>
      </div>
    </div>

    <!-- BROADCAST -->
    <div class="tab-panel" id="tab-broadcast">
      <div class="broadcast-panel">
        <div class="bp-title"><i class="ti ti-speakerphone" style="color:var(--a2);font-size:14px;"></i>Send Broadcast to All Users</div>
        <input type="text" class="bp-input" id="broadcastInput" placeholder="Type a message shown to all connected users..." maxlength="200">
        <div class="bp-row">
          <button class="bp-send" onclick="sendBroadcast()"><i class="ti ti-send" style="font-size:11px;"></i> Send to All</button>
          <button class="bp-clear" onclick="clearBroadcast()">Clear Message</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--txt2);line-height:1.7;">
        Current broadcast: <span id="currentBroadcast" style="color:var(--a3);font-family:var(--mf);">none</span>
      </div>
    </div>

    <!-- IP BANS -->
    <div class="tab-panel" id="tab-bans">
      <div class="sec-hd">
        <div class="sec-title">Banned IPs <span class="cnt" id="banCount">0</span></div>
        <div class="sec-act">
          <button class="sec-btn" onclick="openBanModal()"><i class="ti ti-plus" style="font-size:10px;"></i>Ban IP</button>
        </div>
      </div>
      <div id="banList"></div>
    </div>

    <!-- INTEREST DATA -->
    <div class="tab-panel" id="tab-interests">
      <div class="sec-hd"><div class="sec-title">Interest Frequency Heatmap</div></div>
      <div class="heatmap" id="interestHeatmap"></div>
    </div>

  </div>
</div>

<!-- BAN MODAL -->
<div class="modal-overlay" id="banModal">
  <div class="modal-box">
    <div class="modal-title">Ban an IP Address</div>
    <div class="modal-sub">This IP will be blocked from connecting to VoiceMatch.</div>
    <input type="text" class="modal-input" id="banIpInput" placeholder="e.g. 192.168.1.100">
    <div class="modal-btns">
      <button class="modal-cancel" onclick="closeBanModal()">Cancel</button>
      <button class="modal-submit" onclick="submitBan()">Ban IP</button>
    </div>
  </div>
</div>

<div class="a-toast" id="aToast"></div>

<script>
const KEY = new URLSearchParams(location.search).get('key');
let data = null;

function aToast(msg) {
  const t = document.getElementById('aToast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('show'), 2600);
}

function switchTab(id, el) {
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('act'));
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('act'));
  const tp = document.getElementById('tab-'+id);
  if (tp) tp.classList.add('act');
  if (el && el.classList) el.classList.add('act');
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+
         d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
}
function dur(sec) {
  if (sec == null) return '—';
  const m=Math.floor(sec/60), s=sec%60;
  return (m>0?m+'m ':'')+s+'s';
}
function shortSid(sid) { return sid ? sid.slice(0,8)+'…' : '—'; }
function reasonBadge(r) {
  const map = {harassment:'<span class="badge red">Harassment</span>',explicit:'<span class="badge amber">Explicit</span>',spam:'<span class="badge blue">Spam</span>',other:'<span class="badge purple">Other</span>'};
  return map[r] || \`<span class="badge">\${r}</span>\`;
}

function renderOverview() {
  const s = data.stats;
  document.getElementById('statsGrid').innerHTML =
    mkStat(s.totalConnections,'Total Connections','SESSIONS') +
    mkStat(s.totalMatches,'Matched Pairs','MATCHES','var(--a1)') +
    mkStat(s.activeCalls,'Active Calls','RIGHT NOW','var(--a3)',true) +
    mkStat(s.queueSize,'In Queue','WAITING') +
    mkStat(s.totalReports,'Reports','FLAGGED','#ff7070') +
    mkStat(dur(s.avgDuration),'Avg Duration','PER CALL','var(--a2)');

  document.getElementById('activeCount').textContent  = s.activeCalls;
  document.getElementById('sb-active-cnt').textContent = s.activeCalls;
  document.getElementById('sb-queue-cnt').textContent  = s.queueSize;
  document.getElementById('reportCountOv').textContent = Math.min(data.reports.length, 5);
  const rBadge = document.getElementById('sb-report-cnt');
  if (data.reports.length > 0) { rBadge.textContent = data.reports.length; rBadge.style.display=''; }

  const acp = document.getElementById('activeCallsPreview');
  const active = data.active.slice(0,3);
  acp.innerHTML = active.length ? active.map(renderActiveCard).join('') :
    '<div class="table-wrap"><div class="empty-state">No active calls right now</div></div>';

  const rr = document.getElementById('recentReports');
  const rep5 = data.reports.slice(0,5);
  rr.innerHTML = rep5.length ? rep5.map(r=>\`<tr>
    <td class="td-mono">\${fmt(r.ts)}</td>
    <td>\${reasonBadge(r.reason)}</td>
    <td class="td-mono">\${(r.roomId||'').slice(0,16)}…</td>
    <td><span class="ip-chip">\${r.reporterIp}</span></td>
  </tr>\`).join('') : '<tr><td colspan="4" class="empty-state">No reports yet</td></tr>';
}

function mkStat(num, title, lbl, color, highlight) {
  return \`<div class="stat-card\${highlight?' highlight':''}">
    <div class="sc-val" style="color:\${color||'#fff'}">\${num}</div>
    <div class="sc-lbl">\${lbl}</div>
  </div>\`;
}

function renderActiveCard(ac) {
  const qs = (ac.questionsShown||[]).map(i=>\`<span class="ac-q">Q\${i+1}</span>\`).join('');
  const elapsed = Math.round((Date.now()-new Date(ac.startTs))/1000);
  return \`<div class="ac-card">
    <div class="ac-left">
      <div class="ac-room">Room: \${ac.roomId.slice(0,28)}…</div>
      <div class="ac-peers">
        <div class="ac-peer"><div class="ac-peer-sid">\${shortSid(ac.peerA?.sid)}</div><div class="ac-peer-ip">\${ac.peerA?.ip}</div></div>
        <div class="ac-vs">↔</div>
        <div class="ac-peer"><div class="ac-peer-sid">\${shortSid(ac.peerB?.sid)}</div><div class="ac-peer-ip">\${ac.peerB?.ip}</div></div>
      </div>
      <div class="ac-qs">\${qs||'<span class="ac-q">No questions yet</span>'}</div>
    </div>
    <div class="ac-right">
      <div class="ac-timer">\${dur(elapsed)}</div>
      <button class="kill-btn" onclick="killCall('\${ac.roomId}')">Kill Call</button>
    </div>
  </div>\`;
}

function renderActive() {
  document.getElementById('liveCount2').textContent = data.active.length;
  const el = document.getElementById('activeCallsFull');
  el.innerHTML = data.active.length ? data.active.map(renderActiveCard).join('') :
    '<div class="table-wrap"><div class="empty-state">No active calls right now</div></div>';
}

function renderQueue() {
  document.getElementById('queueCount').textContent = data.queue.length;
  const el = document.getElementById('queueList');
  if (!data.queue.length) { el.innerHTML='<div class="table-wrap"><div class="empty-state">Queue is empty</div></div>'; return; }
  el.innerHTML = data.queue.map(u=>\`<div class="queue-card">
    <div>
      <div class="qc-sid">\${shortSid(u.id)}</div>
      <div class="qc-interests">\${(u.interests||[]).map(i=>\`<span class="qc-int">\${i}</span>\`).join('')||'<span style="font-size:9px;color:var(--txt3);">No interests</span>'}</div>
    </div>
    <div class="qc-wait">Waiting…</div>
  </div>\`).join('');
}

function renderCalls() {
  document.getElementById('callHistCount').textContent = data.calls.length;
  const tb = document.getElementById('callHistBody');
  tb.innerHTML = data.calls.length ? data.calls.map((c,i)=>\`<tr>
    <td class="td-mono">\${i+1}</td>
    <td class="td-mono" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${c.roomId.slice(5,22)}…</td>
    <td><span class="sid-chip">\${shortSid(c.peerA?.sid)}</span><br><span class="ip-chip">\${c.peerA?.ip}</span></td>
    <td><span class="sid-chip">\${shortSid(c.peerB?.sid)}</span><br><span class="ip-chip">\${c.peerB?.ip}</span></td>
    <td class="td-mono">\${fmt(c.startTs)}</td>
    <td><span class="badge green">\${dur(c.durationSec)}</span></td>
    <td>\${(c.questionsShown||[]).map(q=>\`<span class="badge blue">Q\${q+1}</span>\`).join(' ')}</td>
  </tr>\`).join('') : '<tr><td colspan="7" class="empty-state">No completed calls yet</td></tr>';
}

function renderReports() {
  document.getElementById('allReportCount').textContent = data.reports.length;
  const tb = document.getElementById('allReportsBody');
  tb.innerHTML = data.reports.length ? data.reports.map((r,i)=>\`<tr>
    <td class="td-mono">\${i+1}</td>
    <td class="td-mono">\${fmt(r.ts)}</td>
    <td>\${reasonBadge(r.reason)}</td>
    <td style="max-width:180px;font-size:10px;color:var(--txt3);">\${r.description||'—'}</td>
    <td class="td-mono" style="max-width:100px">\${(r.roomId||'').slice(0,14)}…</td>
    <td><span class="sid-chip">\${shortSid(r.reporterSid)}</span></td>
    <td><span class="ip-chip">\${r.reporterIp}</span></td>
    <td><button class="kill-btn" onclick="banIpDirect('\${r.reporterIp}')">Ban IP</button></td>
  </tr>\`).join('') : '<tr><td colspan="8" class="empty-state">No reports yet</td></tr>';
}

function renderHomepage() {
  if (!data.homepageStats) return;
  const s = data.homepageStats;
  document.getElementById('es-activeUsers').value = s.activeUsers||'';
  document.getElementById('es-avgMatch').value    = s.avgMatch||'';
  document.getElementById('es-anonymous').value   = s.anonymous||'';
  document.getElementById('es-uptime').value      = s.uptime||'';

  // Mini chart
  const calls10 = data.calls.slice(0,10).reverse();
  const maxDur = Math.max(1, ...calls10.map(c=>c.durationSec||0));
  const mc = document.getElementById('miniChart');
  mc.innerHTML = calls10.length ? calls10.map(c=>{
    const pct = ((c.durationSec||0)/maxDur)*100;
    return \`<div class="mini-bar" style="height:\${Math.max(2,pct)}%" title="\${dur(c.durationSec)}"></div>\`;
  }).join('') : '<div style="color:var(--txt3);font-size:10px;">No calls logged yet</div>';
}

function renderBroadcast() {
  document.getElementById('broadcastInput').value = data.broadcastMsg||'';
  document.getElementById('currentBroadcast').textContent = data.broadcastMsg||'none';
}

function renderBans() {
  const bans = data.bannedIPs||[];
  document.getElementById('banCount').textContent = bans.length;
  const el = document.getElementById('banList');
  el.innerHTML = bans.length ? bans.map(ip=>\`<div class="ban-item">
    <span class="ban-ip">\${ip}</span>
    <button class="unban-btn" onclick="unbanIp('\${ip}')">Unban</button>
  </div>\`).join('') : '<div style="font-size:11px;color:var(--txt3);padding:12px 0;">No IPs banned</div>';
}

function renderInterests() {
  const freq = data.stats.interestFreq||{};
  const entries = Object.entries(freq).sort((a,b)=>b[1]-a[1]);
  const max = entries.length ? entries[0][1] : 1;
  const el = document.getElementById('interestHeatmap');
  el.innerHTML = entries.length ? entries.map(([name,count])=>\`<div class="hm-item">
    <div class="hm-name">\${name}</div>
    <div class="hm-bar-wrap"><div class="hm-bar" style="width:\${Math.max(5,(count/max)*100)}%"></div></div>
    <div class="hm-count">\${count} selections</div>
  </div>\`).join('') : '<div style="color:var(--txt3);font-size:11px;">No data yet</div>';
}

async function saveHomepageStats() {
  const payload = {
    activeUsers: document.getElementById('es-activeUsers').value,
    avgMatch:    document.getElementById('es-avgMatch').value,
    anonymous:   document.getElementById('es-anonymous').value,
    uptime:      document.getElementById('es-uptime').value,
  };
  const r = await fetch(\`/admin-api/update-stats?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const d = await r.json();
  if (d.ok) aToast('Homepage stats updated and pushed live');
  else aToast('Failed to update stats');
}

async function sendBroadcast() {
  const msg = document.getElementById('broadcastInput').value.trim();
  await fetch(\`/admin-api/broadcast?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
  aToast(msg ? 'Broadcast sent to all users' : 'Broadcast cleared');
  document.getElementById('currentBroadcast').textContent = msg||'none';
}
async function clearBroadcast() {
  document.getElementById('broadcastInput').value='';
  await fetch(\`/admin-api/broadcast?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:''})});
  aToast('Broadcast cleared');
  document.getElementById('currentBroadcast').textContent='none';
}

async function killCall(roomId) {
  if (!confirm('Kill this call? Both users will be disconnected.')) return;
  const r = await fetch(\`/admin-api/kill-call?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId})});
  const d = await r.json();
  aToast(d.ok ? 'Call terminated' : 'Room not found');
  loadData();
}
async function confirmKillAll() {
  if (!data.active.length) { aToast('No active calls to kill'); return; }
  if (!confirm(\`Kill all \${data.active.length} active calls?\`)) return;
  for (const ac of data.active) await killCall(ac.roomId);
  aToast('All calls terminated');
}

function openBanModal() { document.getElementById('banModal').classList.add('open'); document.getElementById('banIpInput').value=''; }
function closeBanModal() { document.getElementById('banModal').classList.remove('open'); }
async function submitBan() {
  const ip = document.getElementById('banIpInput').value.trim();
  if (!ip) return;
  await fetch(\`/admin-api/ban-ip?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  closeBanModal(); aToast('IP banned: '+ip); loadData();
}
async function banIpDirect(ip) {
  await fetch(\`/admin-api/ban-ip?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  aToast('IP banned: '+ip); loadData();
}
async function unbanIp(ip) {
  await fetch(\`/admin-api/unban-ip?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip})});
  aToast('IP unbanned: '+ip); loadData();
}

document.getElementById('banModal').addEventListener('click',function(e){if(e.target===this)closeBanModal();});

async function loadData() {
  try {
    const r = await fetch(\`/admin-api/all?key=\${KEY}\`);
    data = await r.json();
    document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    renderOverview(); renderActive(); renderQueue(); renderCalls();
    renderReports(); renderHomepage(); renderBroadcast(); renderBans(); renderInterests();
  } catch(e) { console.error(e); }
}
loadData();
setInterval(loadData, 6000);
</script>
</body>
</html>`;
}

httpServer.listen(PORT, () => {
  console.log(`VoiceMatch v6 → http://localhost:${PORT}`);
  console.log(`Admin panel → http://localhost:${PORT}/admin?key=${ADMIN_SECRET}`);
});
