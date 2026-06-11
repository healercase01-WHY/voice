/* =========================================================================
   VoiceMatch Final Server — v3
   - HTTP matchmake (index.html flow)
   - Socket join-queue (lab.html flow) 
   - Question sync + skip-vote system
   ========================================================================= */

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const { Server } = require('socket.io');

const PORT = 3000;

const MIME = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.ico':  'image/x-icon',
    '.mp3':  'audio/mpeg',
    '.mpeg': 'audio/mpeg',
};

const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/matchmake') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { socketId } = JSON.parse(body);
                const result = processMatchmake(socketId);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(result));
            } catch(e) { res.writeHead(400); res.end('Bad request'); }
        });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end(); return;
    }
    let urlPath = req.url === '/' ? '/index.html' : req.url;
    urlPath = urlPath.split('?')[0];
    const filePath = path.join(__dirname, 'frontend', urlPath);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(data);
    });
});

const io = new Server(httpServer, { cors: { origin: '*' } });

let matchingPool   = {};  // { socketId: { id, interests, source } }
let activeRoomsMap = {};  // socketId -> roomId
let roomTimers     = {};
const roomState    = {};  // roomId -> { questionIndex, turnSocketId, members, skipVotes: Set }
const pendingInterests = {};

// ── Shared match logic ───────────────────────────────────────
function doMatch(idA, idB, roomId) {
    const sockA = io.sockets.sockets.get(idA);
    const sockB = io.sockets.sockets.get(idB);
    if (sockA) sockA.join(roomId);
    if (sockB) sockB.join(roomId);
    activeRoomsMap[idA] = roomId;
    activeRoomsMap[idB] = roomId;

    const firstQ = Math.floor(Math.random() * 50);
    roomState[roomId] = {
        questionIndex: firstQ,
        turnSocketId:  idA,
        members:       [idA, idB],
        skipVotes:     new Set(),
    };

    roomTimers[roomId] = setTimeout(() => {
        if (activeRoomsMap[idA] === roomId || activeRoomsMap[idB] === roomId) {
            io.to(roomId).emit('lab-signal', { peerDisconnectedSignal: true, reason: 'timeout' });
            cleanRoom(roomId, [idA, idB]);
        }
    }, 30000);

    console.log(`⚡ Matched: ${idA.slice(0,5)} + ${idB.slice(0,5)} | Room: ${roomId}`);
}

// ── HTTP matchmake (index.html) ──────────────────────────────
function processMatchmake(socketId) {
    delete matchingPool[socketId]; // remove stale entry
    const interests = pendingInterests[socketId] || [];
    delete pendingInterests[socketId];

    const waiting = Object.values(matchingPool).filter(u => u.source === 'http');
    if (waiting.length === 0) {
        matchingPool[socketId] = { id: socketId, interests, source: 'http' };
        return { action: 'wait', roomId: `room_${socketId}_pending` };
    }

    // Best interest match
    let bestPeer = waiting[0], bestScore = -1;
    for (const peer of waiting) {
        const score = interests.filter(i => peer.interests.includes(i)).length;
        if (score > bestScore) { bestScore = score; bestPeer = peer; }
    }
    delete matchingPool[bestPeer.id];

    const roomId = `room_${bestPeer.id}_${socketId}`;
    doMatch(bestPeer.id, socketId, roomId);

    const sockA = io.sockets.sockets.get(bestPeer.id);
    if (sockA) sockA.emit('peer-ready', { roomId, role: 'A' });

    return { action: 'matched', roomId, role: 'B' };
}

// ── Socket events ────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`Node linked: ${socket.id}`);

    socket.on('set-interests', ({ interests }) => {
        pendingInterests[socket.id] = Array.isArray(interests) ? interests : [];
    });

    // Lab.html queue entry (socket-based matchmaking)
    socket.on('join-queue', ({ interests }) => {
        pendingInterests[socket.id] = Array.isArray(interests) ? interests : [];
        delete matchingPool[socket.id];

        const waiting = Object.values(matchingPool).filter(u => u.source === 'socket');
        if (waiting.length === 0) {
            matchingPool[socket.id] = { id: socket.id, interests: pendingInterests[socket.id], source: 'socket' };
            socket.emit('match-waiting', { message: 'Waiting for a peer...' });
            console.log(`⏳ ${socket.id.slice(0,5)} queued (socket)`);
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

    // Skip vote — both must vote to advance
    socket.on('skip-vote', ({ roomId }) => {
        const rs = roomState[roomId];
        if (!rs) return;

        rs.skipVotes.add(socket.id);
        const count = rs.skipVotes.size;

        // Broadcast current vote state to room
        io.to(roomId).emit('skip-update', {
            votes:     [...rs.skipVotes],
            myVote:    true,   // receiver checks against their own socket.id
            total:     2,
        });

        if (count >= 2) {
            // Both voted — advance question
            rs.questionIndex = (rs.questionIndex + 1) % 50;
            rs.skipVotes     = new Set();
            rs.turnSocketId  = socket.id; // requester of final vote goes first

            io.to(roomId).emit('room-state', {
                questionIndex: rs.questionIndex,
                turnSocketId:  rs.turnSocketId,
                members:       rs.members,
                skipVotes:     [],
            });
        }
    });

    // Next question (turn-based, no vote needed)
    socket.on('next-question', ({ roomId }) => {
        const rs = roomState[roomId];
        if (!rs) return;
        rs.questionIndex = (rs.questionIndex + 1) % 50;
        rs.turnSocketId  = socket.id;
        rs.skipVotes     = new Set();
        io.to(roomId).emit('room-state', {
            questionIndex: rs.questionIndex,
            turnSocketId:  rs.turnSocketId,
            members:       rs.members,
            skipVotes:     [],
        });
    });

    socket.on('disconnect', () => {
        console.log(`❌ Link broken: ${socket.id}`);
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
    peerIds.forEach(id => delete activeRoomsMap[id]);
    delete roomState[roomId];
    if (roomTimers[roomId]) { clearTimeout(roomTimers[roomId]); delete roomTimers[roomId]; }
    console.log(`🧹 Room cleaned: ${roomId}`);
}

httpServer.listen(PORT, () => console.log(`🎙  VoiceMatch v3 → http://localhost:${PORT}`));
