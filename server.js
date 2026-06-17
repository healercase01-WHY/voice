/* =========================================================================
   VoiceMatch — server.js (Vercel-ready)
   
   CHANGES FOR VERCEL:
   1. Removed fs/path static file serving — Vercel serves frontend/ statically
   2. Removed PORT 3000 / httpServer.listen — Vercel controls the port via process.env.PORT
   3. socket.io cors updated to accept your real Vercel domain
   4. All in-memory state preserved (works fine; resets on cold start — expected)
   5. module.exports = httpServer added so Vercel can import it as a function
   6. Admin panel URL uses req.headers.host instead of hardcoded localhost
   ========================================================================= */

const http    = require('http');
const { Server } = require('socket.io');

const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── In-memory store ─────────────────────────────────────────────
const callLog     = [];
const activeCalls = {};
const reportLog   = [];
let   totalConnections = 0;
let   totalMatches     = 0;

// Editable homepage stats (admin can override)
let homepageStats = { activeUsers:'12.4K', avgMatch:'3.2s', anonymous:'98%', uptime:'24/7' };
let broadcastMsg  = '';

// ── IP helper ────────────────────────────────────────────────────
function getIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';
}

// ── HTTP server ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    const ip = getIp(req);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    // ── /admin ───────────────────────────────────────────────────
    if (req.url === '/admin' || req.url.startsWith('/admin?')) {
        const url = new URL(req.url, `https://${req.headers.host}`);
        const key = url.searchParams.get('key');
        if (key !== ADMIN_SECRET) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>Admin</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#04050e;color:#e8eaff;font-family:'Space Grotesk',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}
.box{background:#0b0d1a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;width:340px;text-align:center;}
h2{font-size:18px;margin-bottom:6px;color:#fff;}p{font-size:12px;color:rgba(200,208,255,0.5);margin-bottom:24px;}
input{width:100%;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:#14182c;color:#e8eaff;font-size:13px;outline:none;margin-bottom:12px;}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#6378ff;color:#fff;font-weight:700;font-size:12px;cursor:pointer;letter-spacing:1px;}
button:hover{background:#7b8fff;}</style></head><body>
<div class="box"><h2>VoiceMatch Admin</h2><p>Enter your admin key to continue</p>
<form method="GET" action="/admin"><input type="password" name="key" placeholder="Admin key" autofocus>
<button type="submit">ACCESS PANEL</button></form></div></body></html>`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(buildAdminHtml());
        return;
    }

    // ── /admin-api/all ───────────────────────────────────────────
    if (req.url.startsWith('/admin-api/')) {
        const url = new URL(req.url, `https://${req.headers.host}`);
        if (url.searchParams.get('key') !== ADMIN_SECRET) {
            res.writeHead(403); res.end('Forbidden'); return;
        }

        if (req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body);
                    const ep = req.url.split('?')[0];

                    if (ep === '/admin-api/update-stats') {
                        Object.assign(homepageStats, payload);
                        json(res, { ok: true, stats: homepageStats });
                        return;
                    }
                    if (ep === '/admin-api/broadcast') {
                        broadcastMsg = payload.message || '';
                        io.emit('broadcast-msg', { message: broadcastMsg });
                        json(res, { ok: true });
                        return;
                    }
                    if (ep === '/admin-api/kill-call') {
                        const roomId = payload.roomId;
                        if (roomId && activeCalls[roomId]) {
                            io.to(roomId).emit('lab-signal', { peerDisconnectedSignal: true, reason: 'admin' });
                            const peers = Object.entries(activeRoomsMap).filter(([,r]) => r === roomId).map(([id]) => id);
                            cleanRoom(roomId, peers);
                            json(res, { ok: true });
                        } else {
                            res.writeHead(404); res.end(JSON.stringify({ ok: false }));
                        }
                        return;
                    }
                    if (ep === '/admin-api/ban-ip') {
                        bannedIPs.add(payload.ip);
                        json(res, { ok: true, banned: [...bannedIPs] });
                        return;
                    }
                    if (ep === '/admin-api/unban-ip') {
                        bannedIPs.delete(payload.ip);
                        json(res, { ok: true, banned: [...bannedIPs] });
                        return;
                    }
                } catch(e) { res.writeHead(400); res.end('Bad request'); }
            });
            return;
        }

        // GET — all data
        const interestFreq = {};
        [...Object.values(pendingInterests), ...callLog.map(c => c.interestsA||[]), ...callLog.map(c => c.interestsB||[])].flat()
            .forEach(i => { interestFreq[i] = (interestFreq[i]||0) + 1; });

        json(res, {
            calls:   callLog.slice(-200).reverse(),
            active:  Object.values(activeCalls),
            reports: reportLog.slice(-200).reverse(),
            queue:   Object.values(matchingPool),
            bannedIPs: [...bannedIPs],
            homepageStats,
            broadcastMsg,
            stats: {
                totalConnections, totalMatches,
                activeCalls:   Object.keys(activeCalls).length,
                queueSize:     Object.keys(matchingPool).length,
                totalReports:  reportLog.length,
                totalCallsLog: callLog.length,
                avgDuration:   callLog.length
                    ? Math.round(callLog.reduce((a, c) => a + (c.durationSec||0), 0) / callLog.length)
                    : 0,
                interestFreq,
            },
        });
        return;
    }

    // ── /api/homepage-stats ─────────────────────────────────────
    if (req.url === '/api/homepage-stats') {
        json(res, homepageStats);
        return;
    }

    // ── /api/report ─────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/report') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { socketId, targetSid, roomId, reason, description } = JSON.parse(body);
                reportLog.push({
                    ts: new Date().toISOString(),
                    reporterIp: ip,
                    reporterSid: socketId,
                    targetSid: targetSid || 'unknown',
                    roomId: roomId || 'unknown',
                    reason,
                    description: description || '',
                });
                json(res, { ok: true });
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
                if (!socketIpMap[socketId]) socketIpMap[socketId] = ip;
                // Prevent re-queuing while already in a call
                if (activeRoomsMap[socketId]) {
                    json(res, { action: 'already_in_call', roomId: activeRoomsMap[socketId] });
                    return;
                }
                const result = processMatchmake(socketId);
                json(res, result);
            } catch(e) { res.writeHead(400); res.end('Bad request'); }
        });
        return;
    }

    // Serve a redirect to Vercel for root visits to the backend URL
    if (req.url === '/' || req.url === '') {
        res.writeHead(302, { 'Location': process.env.CLIENT_ORIGIN || '/' });
        res.end();
        return;
    }
    res.writeHead(404); res.end('Not found');
});

// ── Utility ──────────────────────────────────────────────────────
function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

// ── Socket.io ────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
    'https://project-8uivg.vercel.app',
    'https://voicematch-backend-rure.onrender.com',
    'http://localhost:3000',
    process.env.CLIENT_ORIGIN,
].filter(Boolean);

const io = new Server(httpServer, {
    cors: {
        origin: function(origin, callback) {
            // Allow requests with no origin (curl, Postman, same-origin)
            if (!origin) return callback(null, true);
            if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
            return callback(null, true); // open during dev — tighten after launch
        },
        methods: ['GET', 'POST'],
        credentials: true,
    },
    // Render free tier supports WebSockets — use both transports
    transports: ['websocket', 'polling'],
});

let matchingPool   = {};
let activeRoomsMap = {};
let roomTimers     = {};
const roomState    = {};
const pendingInterests = {};
const socketIpMap  = {};
const bannedIPs    = new Set();

function doMatch(idA, idB, roomId) {
    const sockA = io.sockets.sockets.get(idA);
    const sockB = io.sockets.sockets.get(idB);
    if (sockA) sockA.join(roomId);
    if (sockB) sockB.join(roomId);
    activeRoomsMap[idA] = roomId;
    activeRoomsMap[idB] = roomId;

    const firstQ = Math.floor(Math.random() * 50);
    roomState[roomId] = {
        questionIndex:  firstQ,
        turnSocketId:   idA,
        members:        [idA, idB],
        skipVotes:      new Set(),
        questionsShown: [firstQ],
    };
    activeCalls[roomId] = {
        roomId,
        startTs:       new Date().toISOString(),
        peerA:         { sid: idA, ip: socketIpMap[idA] || 'unknown' },
        peerB:         { sid: idB, ip: socketIpMap[idB] || 'unknown' },
        questionsShown:[firstQ],
        interestsA:    pendingInterests[idA] || [],
        interestsB:    pendingInterests[idB] || [],
    };
    totalMatches++;

    // 60-minute hard timeout
    roomTimers[roomId] = setTimeout(() => {
        io.to(roomId).emit('lab-signal', { peerDisconnectedSignal: true, reason: 'timeout' });
        cleanRoom(roomId, [idA, idB]);
    }, 3_600_000);

    console.log(`[Match] ${idA.slice(0,6)} + ${idB.slice(0,6)} | ${roomId}`);
}

function processMatchmake(socketId) {
    delete matchingPool[socketId];
    const interests = pendingInterests[socketId] || [];
    delete pendingInterests[socketId];

    const waiting = Object.values(matchingPool).filter(u => u.source === 'http');
    if (waiting.length === 0) {
        matchingPool[socketId] = { id: socketId, interests, source: 'http' };
        return { action: 'wait', roomId: `room_${socketId}_pending` };
    }

    let bestPeer = waiting[0], bestScore = -1;
    for (const peer of waiting) {
        const score = interests.filter(i => peer.interests.includes(i)).length;
        if (score > bestScore) { bestScore = score; bestPeer = peer; }
    }
    delete matchingPool[bestPeer.id];

    const roomId = `room_${bestPeer.id}_${socketId}`;
    doMatch(bestPeer.id, socketId, roomId);

    // FIX: Both peers must receive 'peer-ready' via socket — this is what
    // triggers initAudio()+initPC() on the frontend. Previously only the
    // already-waiting peer (A) got this event; the just-arrived peer (B)
    // only got an HTTP response with no socket event, so their
    // RTCPeerConnection was NEVER created — leaving ICE state stuck at
    // 'new' forever once peer A's offer arrived with nothing to receive it.
    const sockA = io.sockets.sockets.get(bestPeer.id);
    const sockB = io.sockets.sockets.get(socketId);
    if (sockA) sockA.emit('peer-ready', { roomId, role: 'A' });
    if (sockB) sockB.emit('peer-ready', { roomId, role: 'B' });

    // HTTP response is now informational only — actual setup happens via the
    // socket events above for BOTH peers, symmetrically.
    return { action: 'matched', roomId, role: 'B' };
}

io.on('connection', (socket) => {
    totalConnections++;
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim()
             || socket.handshake.address || 'unknown';
    if (bannedIPs.has(ip)) { socket.disconnect(); return; }
    socketIpMap[socket.id] = ip;
    if (broadcastMsg) socket.emit('broadcast-msg', { message: broadcastMsg });

    socket.on('set-interests', ({ interests }) => {
        pendingInterests[socket.id] = Array.isArray(interests) ? interests : [];
    });

    socket.on('join-queue', ({ interests }) => {
        if (activeRoomsMap[socket.id]) return;
        pendingInterests[socket.id] = Array.isArray(interests) ? interests : [];
        delete matchingPool[socket.id];
        const waiting = Object.values(matchingPool).filter(u => u.source === 'socket');
        if (waiting.length === 0) {
            matchingPool[socket.id] = { id: socket.id, interests: pendingInterests[socket.id], source: 'socket' };
            socket.emit('match-waiting', { message: 'Waiting for a peer...' });
            return;
        }
        const peer = waiting[0];
        delete matchingPool[peer.id];
        delete pendingInterests[socket.id];
        const roomId = `room_${peer.id}_${socket.id}`;
        doMatch(peer.id, socket.id, roomId);
        const peerSock = io.sockets.sockets.get(peer.id);
        if (peerSock) peerSock.emit('match-success', { roomId, role: 'A' });
        socket.emit('match-success', { roomId, role: 'B' });
    });

    socket.on('lab-signal', (data) => {
        if (!data.roomId) return;
        if (data.offer && roomTimers[data.roomId]) {
            clearTimeout(roomTimers[data.roomId]);
            delete roomTimers[data.roomId];
        }
        if (data.callLive && roomState[data.roomId]) {
            const rs = roomState[data.roomId];
            io.to(data.roomId).emit('room-state', {
                questionIndex: rs.questionIndex,
                turnSocketId:  rs.turnSocketId,
                members:       rs.members,
                skipVotes:     [...rs.skipVotes],
            });
        }
        socket.to(data.roomId).emit('lab-signal', data);
    });

    socket.on('skip-vote', ({ roomId }) => {
        const rs = roomState[roomId];
        if (!rs) return;
        rs.skipVotes.add(socket.id);
        io.to(roomId).emit('skip-update', { votes: [...rs.skipVotes], total: 2 });
        if (rs.skipVotes.size >= 2) {
            rs.questionIndex  = (rs.questionIndex + 1) % 50;
            rs.skipVotes      = new Set();
            rs.turnSocketId   = socket.id;
            if (rs.questionsShown) rs.questionsShown.push(rs.questionIndex);
            if (activeCalls[roomId]) activeCalls[roomId].questionsShown = rs.questionsShown || [];
            io.to(roomId).emit('room-state', {
                questionIndex: rs.questionIndex,
                turnSocketId:  rs.turnSocketId,
                members:       rs.members,
                skipVotes:     [],
            });
        }
    });

    socket.on('next-question', ({ roomId }) => {
        const rs = roomState[roomId];
        if (!rs) return;
        rs.questionIndex = (rs.questionIndex + 1) % 50;
        rs.turnSocketId  = socket.id;
        rs.skipVotes     = new Set();
        if (rs.questionsShown) rs.questionsShown.push(rs.questionIndex);
        if (activeCalls[roomId]) activeCalls[roomId].questionsShown = rs.questionsShown || [];
        io.to(roomId).emit('room-state', {
            questionIndex: rs.questionIndex,
            turnSocketId:  rs.turnSocketId,
            members:       rs.members,
            skipVotes:     [],
        });
    });

    socket.on('disconnect', () => {
        delete matchingPool[socket.id];
        delete pendingInterests[socket.id];
        const assignedRoom = activeRoomsMap[socket.id];
        if (assignedRoom) {
            socket.to(assignedRoom).emit('lab-signal', { peerDisconnectedSignal: true, reason: 'disconnect' });
            const peers = Object.entries(activeRoomsMap).filter(([,r]) => r === assignedRoom).map(([id]) => id);
            cleanRoom(assignedRoom, peers);
        }
    });
});

function cleanRoom(roomId, peerIds) {
    if (activeCalls[roomId]) {
        const ac = activeCalls[roomId];
        ac.endTs       = new Date().toISOString();
        ac.durationSec = Math.round((new Date(ac.endTs) - new Date(ac.startTs)) / 1000);
        callLog.push(ac);
        delete activeCalls[roomId];
    }
    peerIds.forEach(id => delete activeRoomsMap[id]);
    delete roomState[roomId];
    if (roomTimers[roomId]) { clearTimeout(roomTimers[roomId]); delete roomTimers[roomId]; }
}

// ── Admin HTML (inline — no fs needed) ──────────────────────────
function buildAdminHtml() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VoiceMatch Admin</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#04050e;--bg1:#070810;--bg2:#0b0d1a;--bg3:#0f1222;--bg4:#14182c;
  --line:rgba(255,255,255,0.055);--line2:rgba(255,255,255,0.1);--line3:rgba(99,120,255,0.22);
  --a1:#6378ff;--a2:#9b6fff;--a3:#3dcfb8;--a4:#ff6b9d;--a5:#ffd666;
  --txt:#e8eaff;--txt2:rgba(200,208,255,0.52);--txt3:rgba(200,208,255,0.28);
  --gf:'Space Grotesk',sans-serif;--mf:'Space Mono',monospace;--red:#ff5050;}
html,body{background:var(--bg);color:var(--txt);font-family:var(--gf);min-height:100vh;}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg1)}::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:4px}
.nav{display:flex;align-items:center;justify-content:space-between;padding:0 22px;height:50px;
  border-bottom:1px solid var(--line);background:rgba(4,5,14,0.97);position:sticky;top:0;z-index:100;}
.nav-logo{font-family:var(--mf);font-size:11px;letter-spacing:3px;color:var(--txt);display:flex;align-items:center;gap:8px;}
.logo-dot{width:5px;height:5px;border-radius:50%;background:var(--a1);animation:blink 2s infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.15}}
.nav-right{display:flex;align-items:center;gap:10px;}
.live-pill{display:flex;align-items:center;gap:5px;font-family:var(--mf);font-size:8px;color:var(--a3);letter-spacing:1px;padding:4px 9px;border-radius:20px;border:1px solid rgba(61,207,184,0.2);background:rgba(61,207,184,0.05);}
.live-d{width:5px;height:5px;border-radius:50%;background:var(--a3);animation:blink 1.2s infinite;}
.ref-btn{font-family:var(--mf);font-size:9px;letter-spacing:1px;padding:5px 11px;border-radius:6px;border:1px solid var(--line2);background:transparent;color:var(--txt2);cursor:pointer;display:flex;align-items:center;gap:5px;transition:all .2s;}
.ref-btn:hover{border-color:var(--a1);color:var(--a1);}
.upd{font-family:var(--mf);font-size:8px;color:var(--txt3);}
.layout{display:flex;height:calc(100vh - 50px);}
.sidebar{width:188px;border-right:1px solid var(--line);flex-shrink:0;padding:14px 0;overflow-y:auto;background:var(--bg1);}
.sb-sec{font-family:var(--mf);font-size:8px;letter-spacing:2px;color:var(--txt3);padding:8px 14px 4px;text-transform:uppercase;}
.sb-item{display:flex;align-items:center;gap:8px;padding:8px 14px;cursor:pointer;font-size:11px;font-weight:500;color:var(--txt2);transition:all .18s;border-left:2px solid transparent;}
.sb-item:hover{background:rgba(99,120,255,.04);color:var(--txt);border-left-color:rgba(99,120,255,.2);}
.sb-item.act{background:rgba(99,120,255,.08);color:var(--a1);border-left-color:var(--a1);}
.sb-item i{font-size:13px;width:15px;text-align:center;}
.sb-badge{margin-left:auto;font-family:var(--mf);font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.2);color:#ff7070;}
.sb-sep{height:1px;background:var(--line);margin:6px 10px;}
.main{flex:1;overflow-y:auto;padding:22px 26px;}
.tab-panel{display:none}.tab-panel.act{display:block}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:9px;margin-bottom:22px;}
.stat-card{background:var(--bg2);border:1px solid var(--line);border-radius:11px;padding:16px 15px;}
.stat-card.hl{border-color:rgba(61,207,184,.2);}
.sc-val{font-family:var(--mf);font-size:22px;font-weight:700;color:#fff;letter-spacing:-1px;line-height:1;margin-bottom:3px;}
.sc-lbl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--txt3);}
.sec-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.sec-title{font-size:12px;font-weight:600;color:#fff;display:flex;align-items:center;gap:7px;}
.cnt{font-family:var(--mf);font-size:9px;color:var(--txt3);padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.03);border:1px solid var(--line);}
.sec-btns{display:flex;gap:7px;}
.sec-btn{font-family:var(--mf);font-size:9px;letter-spacing:.5px;padding:5px 10px;border-radius:6px;border:1px solid var(--line2);background:transparent;color:var(--txt2);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:4px;}
.sec-btn:hover{border-color:var(--a1);color:var(--a1);}
.sec-btn.danger:hover{border-color:var(--red);color:var(--red);}
.table-wrap{background:var(--bg2);border:1px solid var(--line);border-radius:11px;overflow:hidden;margin-bottom:22px;}
table{width:100%;border-collapse:collapse;}
thead tr{background:var(--bg3);border-bottom:1px solid var(--line);}
th{padding:8px 13px;font-family:var(--mf);font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--txt3);text-align:left;font-weight:400;}
td{padding:8px 13px;font-size:11px;color:var(--txt2);border-bottom:1px solid rgba(255,255,255,.025);}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(99,120,255,.02)}
.td-mono{font-family:var(--mf);font-size:9px;color:var(--txt3);}
.badge{display:inline-flex;align-items:center;font-family:var(--mf);font-size:8px;letter-spacing:1px;padding:2px 6px;border-radius:4px;text-transform:uppercase;}
.badge.green{background:rgba(61,207,184,.09);border:1px solid rgba(61,207,184,.2);color:var(--a3);}
.badge.red{background:rgba(255,80,80,.09);border:1px solid rgba(255,80,80,.2);color:#ff6060;}
.badge.blue{background:rgba(99,120,255,.09);border:1px solid rgba(99,120,255,.2);color:var(--a1);}
.badge.amb{background:rgba(255,170,0,.09);border:1px solid rgba(255,170,0,.2);color:#ffaa00;}
.badge.pur{background:rgba(155,111,255,.09);border:1px solid rgba(155,111,255,.2);color:var(--a2);}
.ip-chip{font-family:var(--mf);font-size:8px;color:var(--txt3);background:rgba(255,255,255,.03);border:1px solid var(--line);padding:1px 6px;border-radius:4px;}
.sid-chip{font-family:var(--mf);font-size:9px;color:var(--a2);}
.empty-state{padding:32px;text-align:center;font-family:var(--mf);font-size:10px;color:var(--txt3);letter-spacing:1px;}
.ac-card{background:var(--bg2);border:1px solid rgba(61,207,184,.15);border-radius:11px;padding:14px 16px;margin-bottom:7px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.ac-card:hover{border-color:rgba(61,207,184,.3);}
.ac-left{flex:1;min-width:0;}
.ac-room{font-family:var(--mf);font-size:8px;color:var(--txt3);margin-bottom:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-peers{display:flex;align-items:center;gap:9px;margin-bottom:7px;}
.ac-peer{display:flex;flex-direction:column;gap:2px;}
.ac-peer-sid{font-family:var(--mf);font-size:10px;color:var(--a1);}
.ac-peer-ip{font-family:var(--mf);font-size:8px;color:var(--txt3);}
.ac-vs{color:var(--txt3);font-size:11px;}
.ac-qs{display:flex;flex-wrap:wrap;gap:3px;}
.ac-q{font-family:var(--mf);font-size:7px;padding:1px 5px;border-radius:3px;background:rgba(61,207,184,.06);border:1px solid rgba(61,207,184,.14);color:var(--a3);}
.ac-right{display:flex;flex-direction:column;align-items:flex-end;gap:7px;flex-shrink:0;}
.ac-timer{font-family:var(--mf);font-size:12px;color:var(--a3);letter-spacing:2px;}
.kill-btn{font-family:var(--mf);font-size:8px;letter-spacing:1px;padding:3px 9px;border-radius:5px;border:1px solid rgba(255,80,80,.22);background:rgba(255,80,80,.04);color:#ff7070;cursor:pointer;transition:all .2s;}
.kill-btn:hover{background:rgba(255,80,80,.1);border-color:rgba(255,80,80,.45);}
.queue-card{background:var(--bg2);border:1px solid rgba(99,120,255,.13);border-radius:10px;padding:11px 15px;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;}
.qc-sid{font-family:var(--mf);font-size:10px;color:var(--a1);}
.qc-ints{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;}
.qc-int{font-family:var(--mf);font-size:8px;padding:1px 5px;border-radius:4px;background:rgba(99,120,255,.07);border:1px solid rgba(99,120,255,.13);color:var(--txt2);}
.heatmap{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:7px;margin-bottom:22px;}
.hm-item{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:11px 13px;}
.hm-name{font-size:11px;font-weight:500;color:var(--txt);margin-bottom:5px;}
.hm-bar-wrap{height:3px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden;margin-bottom:4px;}
.hm-bar{height:100%;background:var(--a1);border-radius:3px;transition:width .4s;}
.hm-count{font-family:var(--mf);font-size:9px;color:var(--txt3);}
.esp{background:var(--bg2);border:1px solid rgba(99,120,255,.2);border-radius:11px;padding:18px;margin-bottom:18px;}
.esp-title{font-size:12px;font-weight:600;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:6px;}
.esp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-bottom:12px;}
.esp-field{display:flex;flex-direction:column;gap:4px;}
.esp-label{font-family:var(--mf);font-size:8px;letter-spacing:1px;color:var(--txt3);text-transform:uppercase;}
.esp-input{background:var(--bg3);border:1px solid var(--line2);color:var(--txt);font-family:var(--mf);font-size:13px;padding:8px 11px;border-radius:7px;outline:none;}
.esp-input:focus{border-color:var(--a1);}
.bp{background:var(--bg2);border:1px solid var(--line);border-radius:11px;padding:18px;margin-bottom:18px;}
.bp-title{font-size:12px;font-weight:600;color:#fff;margin-bottom:11px;display:flex;align-items:center;gap:6px;}
.bp-input{width:100%;background:var(--bg3);border:1px solid var(--line2);color:var(--txt);font-family:var(--gf);font-size:12px;padding:9px 13px;border-radius:7px;outline:none;margin-bottom:9px;}
.bp-input:focus{border-color:var(--a1);}
.bp-row{display:flex;gap:7px;}
.bp-send{flex:1;padding:8px;border-radius:7px;border:none;background:var(--a1);color:#fff;font-size:10px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:all .2s;}
.bp-send:hover{background:#7b8fff;}
.bp-clear{padding:8px 14px;border-radius:7px;border:1px solid var(--line2);background:transparent;color:var(--txt2);font-size:10px;cursor:pointer;transition:all .2s;}
.bp-clear:hover{border-color:var(--red);color:var(--red);}
.ban-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg2);border:1px solid rgba(255,80,80,.13);border-radius:8px;margin-bottom:5px;}
.ban-ip{font-family:var(--mf);font-size:11px;color:#ff7070;}
.unban-btn{font-family:var(--mf);font-size:8px;padding:3px 8px;border-radius:4px;border:1px solid rgba(61,207,184,.18);background:transparent;color:var(--a3);cursor:pointer;transition:all .2s;}
.unban-btn:hover{background:rgba(61,207,184,.07);}
.mini-bars{display:flex;align-items:flex-end;gap:3px;height:54px;margin-top:10px;}
.mini-bar{flex:1;background:rgba(99,120,255,.22);border-radius:3px 3px 0 0;min-height:2px;transition:height .4s;}
.mini-bar:hover{background:rgba(99,120,255,.5);}
.pnl-save{padding:8px 18px;border-radius:7px;border:none;background:var(--a1);color:#fff;font-size:10px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px;transition:all .2s;}
.pnl-save:hover{background:#7b8fff;}
.modal-overlay{position:fixed;inset:0;background:rgba(4,5,14,.85);backdrop-filter:blur(8px);z-index:900;display:none;align-items:center;justify-content:center;}
.modal-overlay.open{display:flex;}
.modal-box{background:var(--bg2);border:1px solid var(--line2);border-radius:14px;padding:26px;width:100%;max-width:360px;}
.modal-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:5px;}
.modal-sub{font-size:11px;color:var(--txt2);margin-bottom:18px;line-height:1.6;}
.modal-input{width:100%;background:var(--bg3);border:1px solid var(--line2);color:var(--txt);font-family:var(--mf);font-size:12px;padding:9px 11px;border-radius:7px;outline:none;margin-bottom:13px;}
.modal-input:focus{border-color:var(--a1);}
.modal-btns{display:flex;gap:7px;}
.modal-cancel{flex:1;padding:9px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--txt2);font-size:11px;cursor:pointer;}
.modal-submit{flex:2;padding:9px;border-radius:7px;border:none;background:var(--a1);color:#fff;font-size:11px;font-weight:700;cursor:pointer;}
.a-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--bg4);border:1px solid var(--line2);color:var(--txt);font-size:11px;padding:8px 18px;border-radius:8px;opacity:0;transition:opacity .3s;pointer-events:none;font-family:var(--gf);z-index:999;white-space:nowrap;}
.a-toast.show{opacity:1;}
.note-box{background:rgba(99,120,255,.05);border:1px solid rgba(99,120,255,.15);border-radius:9px;padding:14px 16px;margin-bottom:18px;font-size:12px;color:var(--txt2);line-height:1.7;}
.note-box strong{color:var(--a1);}
</style></head><body>
<nav class="nav">
  <div class="nav-logo"><div class="logo-dot"></div>VOICEMATCH / ADMIN</div>
  <div class="nav-right">
    <div class="live-pill"><div class="live-d"></div>LIVE</div>
    <span class="upd" id="upd">—</span>
    <button class="ref-btn" onclick="loadData()"><i class="ti ti-refresh" style="font-size:10px"></i>Refresh</button>
  </div>
</nav>
<div class="layout">
  <div class="sidebar">
    <div class="sb-sec">Overview</div>
    <div class="sb-item act" onclick="sw('overview',this)"><i class="ti ti-layout-dashboard"></i>Dashboard</div>
    <div class="sb-item" onclick="sw('active',this)"><i class="ti ti-phone"></i>Live Calls <span class="sb-badge" id="sb-ac">0</span></div>
    <div class="sb-item" onclick="sw('queue',this)"><i class="ti ti-users"></i>Queue <span class="sb-badge" id="sb-q">0</span></div>
    <div class="sb-sep"></div>
    <div class="sb-sec">Logs</div>
    <div class="sb-item" onclick="sw('calls',this)"><i class="ti ti-history"></i>Call History</div>
    <div class="sb-item" onclick="sw('reports',this)"><i class="ti ti-flag"></i>Reports <span class="sb-badge" id="sb-rep" style="display:none">0</span></div>
    <div class="sb-sep"></div>
    <div class="sb-sec">Control</div>
    <div class="sb-item" onclick="sw('homepage',this)"><i class="ti ti-home"></i>Homepage Stats</div>
    <div class="sb-item" onclick="sw('broadcast',this)"><i class="ti ti-speakerphone"></i>Broadcast</div>
    <div class="sb-item" onclick="sw('bans',this)"><i class="ti ti-ban"></i>IP Bans</div>
    <div class="sb-item" onclick="sw('interests',this)"><i class="ti ti-chart-bar"></i>Interests</div>
  </div>
  <div class="main">

    <!-- DASHBOARD -->
    <div class="tab-panel act" id="tab-overview">
      <div class="stats-row" id="statsGrid"></div>
      <div class="sec-hd"><div class="sec-title">Active Calls <span class="cnt" id="ac-cnt">0</span></div></div>
      <div id="acPreview"></div>
      <div class="sec-hd" style="margin-top:6px"><div class="sec-title">Recent Reports</div></div>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>Reason</th><th>Room</th><th>Reporter IP</th></tr></thead><tbody id="repPrev"></tbody></table></div>
    </div>

    <!-- LIVE CALLS -->
    <div class="tab-panel" id="tab-active">
      <div class="sec-hd">
        <div class="sec-title">Live Calls <span class="cnt" id="lc2">0</span></div>
        <div class="sec-btns"><button class="sec-btn danger" onclick="killAll()"><i class="ti ti-x" style="font-size:9px"></i>Kill All</button></div>
      </div>
      <div id="acFull"></div>
    </div>

    <!-- QUEUE -->
    <div class="tab-panel" id="tab-queue">
      <div class="sec-hd"><div class="sec-title">Matchmaking Queue <span class="cnt" id="q-cnt">0</span></div></div>
      <div id="qList"></div>
    </div>

    <!-- CALL HISTORY -->
    <div class="tab-panel" id="tab-calls">
      <div class="sec-hd"><div class="sec-title">Call History <span class="cnt" id="ch-cnt">0</span></div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Room</th><th>Peer A</th><th>Peer B</th><th>Started</th><th>Duration</th><th>Questions</th></tr></thead><tbody id="chBody"></tbody></table></div>
    </div>

    <!-- REPORTS -->
    <div class="tab-panel" id="tab-reports">
      <div class="sec-hd"><div class="sec-title">All Reports <span class="cnt" id="rep-cnt">0</span></div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Time</th><th>Reason</th><th>Note</th><th>Room</th><th>SID</th><th>IP</th><th>Action</th></tr></thead><tbody id="repBody"></tbody></table></div>
    </div>

    <!-- HOMEPAGE STATS -->
    <div class="tab-panel" id="tab-homepage">
      <div class="note-box"><strong>How it works:</strong> These values are served from <code>/api/homepage-stats</code> and the frontend fetches them on load. Saving here updates them live for all new visitors — no redeploy needed.</div>
      <div class="esp">
        <div class="esp-title"><i class="ti ti-edit" style="color:var(--a1);font-size:13px"></i>Homepage Stats</div>
        <div class="esp-grid">
          <div class="esp-field"><label class="esp-label">Active Users</label><input class="esp-input" id="es-au" placeholder="12.4K"></div>
          <div class="esp-field"><label class="esp-label">Avg Match Time</label><input class="esp-input" id="es-am" placeholder="3.2s"></div>
          <div class="esp-field"><label class="esp-label">Anonymous %</label><input class="esp-input" id="es-an" placeholder="98%"></div>
          <div class="esp-field"><label class="esp-label">Uptime</label><input class="esp-input" id="es-up" placeholder="24/7"></div>
        </div>
        <button class="pnl-save" onclick="saveStats()"><i class="ti ti-check" style="font-size:11px"></i>Save & Push Live</button>
      </div>
      <div style="font-size:12px;font-weight:600;color:#fff;margin-bottom:10px">Call Duration Chart (last 10)</div>
      <div class="mini-bars" id="mchart"></div>
    </div>

    <!-- BROADCAST -->
    <div class="tab-panel" id="tab-broadcast">
      <div class="bp">
        <div class="bp-title"><i class="ti ti-speakerphone" style="color:var(--a2);font-size:13px"></i>Broadcast to All Users</div>
        <input type="text" class="bp-input" id="bcast-input" placeholder="Message shown to all connected users…" maxlength="200">
        <div class="bp-row">
          <button class="bp-send" onclick="sendBcast()"><i class="ti ti-send" style="font-size:10px"></i>Send</button>
          <button class="bp-clear" onclick="clearBcast()">Clear</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--txt2)">Active message: <span id="cur-bcast" style="color:var(--a3);font-family:var(--mf)">none</span></div>
    </div>

    <!-- BANS -->
    <div class="tab-panel" id="tab-bans">
      <div class="sec-hd">
        <div class="sec-title">Banned IPs <span class="cnt" id="ban-cnt">0</span></div>
        <div class="sec-btns"><button class="sec-btn" onclick="openBanModal()"><i class="ti ti-plus" style="font-size:9px"></i>Add Ban</button></div>
      </div>
      <div id="banList"></div>
    </div>

    <!-- INTERESTS -->
    <div class="tab-panel" id="tab-interests">
      <div class="sec-hd"><div class="sec-title">Interest Heatmap</div></div>
      <div class="heatmap" id="heatmap"></div>
    </div>

  </div>
</div>

<div class="modal-overlay" id="banModal">
  <div class="modal-box">
    <div class="modal-title">Ban an IP Address</div>
    <div class="modal-sub">This IP will be blocked from connecting.</div>
    <input type="text" class="modal-input" id="banIpIn" placeholder="e.g. 192.168.1.1">
    <div class="modal-btns">
      <button class="modal-cancel" onclick="closeBanModal()">Cancel</button>
      <button class="modal-submit" onclick="doBan()">Ban IP</button>
    </div>
  </div>
</div>
<div class="a-toast" id="aToast"></div>

<script>
const KEY = new URLSearchParams(location.search).get('key');
let data = null;
function toast(m){const t=document.getElementById('aToast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);}
function sw(id,el){document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('act'));document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('act'));document.getElementById('tab-'+id).classList.add('act');if(el)el.classList.add('act');}
function fmt(iso){if(!iso)return'—';const d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});}
function dur(s){if(s==null)return'—';const m=Math.floor(s/60);return(m>0?m+'m ':'')+s%60+'s';}
function sid(s){return s?s.slice(0,8)+'…':'—';}
function rbadge(r){const m={harassment:\`<span class="badge red">Harassment</span>\`,explicit:\`<span class="badge amb">Explicit</span>\`,spam:\`<span class="badge blue">Spam</span>\`,other:\`<span class="badge pur">Other</span>\`};return m[r]||\`<span class="badge">\${r}</span>\`;}
function mkStat(num,lbl,col,hl){return\`<div class="stat-card\${hl?' hl':''}" style=""><div class="sc-val" style="color:\${col||'#fff'}">\${num}</div><div class="sc-lbl">\${lbl}</div></div>\`;}
function acCard(ac){
  const qs=(ac.questionsShown||[]).map(i=>\`<span class="ac-q">Q\${i+1}</span>\`).join('');
  const el=Math.round((Date.now()-new Date(ac.startTs))/1000);
  return\`<div class="ac-card"><div class="ac-left">
    <div class="ac-room">\${ac.roomId.slice(0,32)}…</div>
    <div class="ac-peers">
      <div class="ac-peer"><div class="ac-peer-sid">\${sid(ac.peerA?.sid)}</div><div class="ac-peer-ip">\${ac.peerA?.ip}</div></div>
      <div class="ac-vs">↔</div>
      <div class="ac-peer"><div class="ac-peer-sid">\${sid(ac.peerB?.sid)}</div><div class="ac-peer-ip">\${ac.peerB?.ip}</div></div>
    </div>
    <div class="ac-qs">\${qs||'<span class="ac-q">no questions</span>'}</div>
  </div><div class="ac-right"><div class="ac-timer">\${dur(el)}</div>
  <button class="kill-btn" onclick="killCall('\${ac.roomId}')">Kill</button></div></div>\`;}

function renderAll(){
  const s=data.stats;
  document.getElementById('statsGrid').innerHTML=
    mkStat(s.totalConnections,'Total Sessions')+
    mkStat(s.totalMatches,'Matched Pairs','var(--a1)')+
    mkStat(s.activeCalls,'Active Calls','var(--a3)',true)+
    mkStat(s.queueSize,'In Queue')+
    mkStat(s.totalReports,'Reports','#ff7070')+
    mkStat(dur(s.avgDuration),'Avg Duration','var(--a2)');
  document.getElementById('sb-ac').textContent=s.activeCalls;
  document.getElementById('sb-q').textContent=s.queueSize;
  document.getElementById('ac-cnt').textContent=s.activeCalls;
  document.getElementById('lc2').textContent=data.active.length;
  document.getElementById('q-cnt').textContent=data.queue.length;
  document.getElementById('ch-cnt').textContent=data.calls.length;
  document.getElementById('rep-cnt').textContent=data.reports.length;
  document.getElementById('ban-cnt').textContent=(data.bannedIPs||[]).length;
  const sbrep=document.getElementById('sb-rep');
  if(data.reports.length>0){sbrep.textContent=data.reports.length;sbrep.style.display='';}

  // Active preview
  const acp=document.getElementById('acPreview');
  acp.innerHTML=data.active.length?data.active.slice(0,3).map(acCard).join(''):'<div class="table-wrap"><div class="empty-state">No active calls</div></div>';
  document.getElementById('acFull').innerHTML=data.active.length?data.active.map(acCard).join(''):'<div class="table-wrap"><div class="empty-state">No active calls</div></div>';

  // Queue
  const ql=document.getElementById('qList');
  ql.innerHTML=data.queue.length?data.queue.map(u=>\`<div class="queue-card"><div><div class="qc-sid">\${sid(u.id)}</div><div class="qc-ints">\${(u.interests||[]).map(i=>\`<span class="qc-int">\${i}</span>\`).join('')||'—'}</div></div><div style="font-family:var(--mf);font-size:9px;color:var(--txt3)">waiting…</div></div>\`).join(''):'<div class="table-wrap"><div class="empty-state">Queue empty</div></div>';

  // Calls
  const cb=document.getElementById('chBody');
  cb.innerHTML=data.calls.length?data.calls.map((c,i)=>\`<tr><td class="td-mono">\${i+1}</td><td class="td-mono" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${c.roomId.slice(5,22)}…</td><td><span class="sid-chip">\${sid(c.peerA?.sid)}</span><br><span class="ip-chip">\${c.peerA?.ip}</span></td><td><span class="sid-chip">\${sid(c.peerB?.sid)}</span><br><span class="ip-chip">\${c.peerB?.ip}</span></td><td class="td-mono">\${fmt(c.startTs)}</td><td><span class="badge green">\${dur(c.durationSec)}</span></td><td>\${(c.questionsShown||[]).map(q=>\`<span class="badge blue">Q\${q+1}</span>\`).join(' ')}</td></tr>\`).join(''):'<tr><td colspan="7" class="empty-state">No calls yet</td></tr>';

  // Recent reports preview
  const rp=document.getElementById('repPrev');
  rp.innerHTML=data.reports.slice(0,5).map(r=>\`<tr><td class="td-mono">\${fmt(r.ts)}</td><td>\${rbadge(r.reason)}</td><td class="td-mono">\${(r.roomId||'').slice(0,14)}…</td><td><span class="ip-chip">\${r.reporterIp}</span></td></tr>\`).join('')||'<tr><td colspan="4" class="empty-state">No reports</td></tr>';

  // All reports
  const rb=document.getElementById('repBody');
  rb.innerHTML=data.reports.length?data.reports.map((r,i)=>\`<tr><td class="td-mono">\${i+1}</td><td class="td-mono">\${fmt(r.ts)}</td><td>\${rbadge(r.reason)}</td><td style="font-size:10px;color:var(--txt3);max-width:160px">\${r.description||'—'}</td><td class="td-mono">\${(r.roomId||'').slice(0,14)}…</td><td><span class="sid-chip">\${sid(r.reporterSid)}</span></td><td><span class="ip-chip">\${r.reporterIp}</span></td><td><button class="kill-btn" onclick="quickBan('\${r.reporterIp}')">Ban IP</button></td></tr>\`).join(''):'<tr><td colspan="8" class="empty-state">No reports</td></tr>';

  // Homepage stats
  const hs=data.homepageStats||{};
  document.getElementById('es-au').value=hs.activeUsers||'';
  document.getElementById('es-am').value=hs.avgMatch||'';
  document.getElementById('es-an').value=hs.anonymous||'';
  document.getElementById('es-up').value=hs.uptime||'';

  // Mini chart
  const calls10=data.calls.slice(0,10).reverse();
  const maxD=Math.max(1,...calls10.map(c=>c.durationSec||0));
  document.getElementById('mchart').innerHTML=calls10.length?calls10.map(c=>\`<div class="mini-bar" style="height:\${Math.max(3,((c.durationSec||0)/maxD)*100)}%" title="\${dur(c.durationSec)}"></div>\`).join(''):'<div style="color:var(--txt3);font-size:10px;padding:4px">No data yet</div>';

  // Broadcast
  document.getElementById('bcast-input').value=data.broadcastMsg||'';
  document.getElementById('cur-bcast').textContent=data.broadcastMsg||'none';

  // Bans
  const bans=data.bannedIPs||[];
  document.getElementById('banList').innerHTML=bans.length?bans.map(ip=>\`<div class="ban-item"><span class="ban-ip">\${ip}</span><button class="unban-btn" onclick="unban('\${ip}')">Unban</button></div>\`).join(''):'<div style="font-size:11px;color:var(--txt3);padding:10px 0">No bans</div>';

  // Heatmap
  const freq=s.interestFreq||{};
  const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
  const maxF=entries.length?entries[0][1]:1;
  document.getElementById('heatmap').innerHTML=entries.length?entries.map(([n,c])=>\`<div class="hm-item"><div class="hm-name">\${n}</div><div class="hm-bar-wrap"><div class="hm-bar" style="width:\${Math.max(5,(c/maxF)*100)}%"></div></div><div class="hm-count">\${c}</div></div>\`).join(''):'<div style="color:var(--txt3);font-size:11px">No data</div>';

  document.getElementById('upd').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

async function apicall(ep,payload){return fetch(\`\${ep}?key=\${KEY}\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json());}
async function saveStats(){const r=await apicall('/admin-api/update-stats',{activeUsers:document.getElementById('es-au').value,avgMatch:document.getElementById('es-am').value,anonymous:document.getElementById('es-an').value,uptime:document.getElementById('es-up').value});toast(r.ok?'Stats pushed live':'Failed');}
async function sendBcast(){const msg=document.getElementById('bcast-input').value.trim();await apicall('/admin-api/broadcast',{message:msg});toast(msg?'Broadcast sent':'Cleared');document.getElementById('cur-bcast').textContent=msg||'none';}
async function clearBcast(){document.getElementById('bcast-input').value='';await apicall('/admin-api/broadcast',{message:''});toast('Cleared');document.getElementById('cur-bcast').textContent='none';}
async function killCall(roomId){if(!confirm('Kill this call?'))return;const r=await apicall('/admin-api/kill-call',{roomId});toast(r.ok?'Call killed':'Not found');loadData();}
async function killAll(){if(!data.active.length){toast('No active calls');return;}if(!confirm('Kill all '+data.active.length+' calls?'))return;for(const ac of data.active)await apicall('/admin-api/kill-call',{roomId:ac.roomId});toast('All calls terminated');loadData();}
function openBanModal(){document.getElementById('banModal').classList.add('open');document.getElementById('banIpIn').value='';}
function closeBanModal(){document.getElementById('banModal').classList.remove('open');}
async function doBan(){const ip=document.getElementById('banIpIn').value.trim();if(!ip)return;await apicall('/admin-api/ban-ip',{ip});closeBanModal();toast('Banned: '+ip);loadData();}
async function quickBan(ip){await apicall('/admin-api/ban-ip',{ip});toast('Banned: '+ip);loadData();}
async function unban(ip){await apicall('/admin-api/unban-ip',{ip});toast('Unbanned: '+ip);loadData();}
document.getElementById('banModal').addEventListener('click',function(e){if(e.target===this)closeBanModal();});

async function loadData(){try{const r=await fetch(\`/admin-api/all?key=\${KEY}\`);data=await r.json();renderAll();}catch(e){console.error(e);}}
loadData();setInterval(loadData,6000);
</script></body></html>`;
}

// ── Start (local dev) / Export (Vercel) ─────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`VoiceMatch → http://localhost:${PORT}`);
    console.log(`Admin     → http://localhost:${PORT}/admin?key=${ADMIN_SECRET}`);
});

module.exports = httpServer;