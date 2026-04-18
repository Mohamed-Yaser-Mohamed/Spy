import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",  // Allow frontend on HTTP/80 or localhost:5173
    methods: ["GET", "POST"]
  }
});

// Central Memory Store for Rooms
const rooms = {};

// Clean up stale rooms every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of Object.entries(rooms)) {
        // If room is empty or hasn't started after 6 hours, wipe it
        if (room.players.length === 0 || (now - (room.createdAt || now) > 6 * 60 * 60 * 1000)) {
            delete rooms[code];
        }
    }
}, 30 * 60 * 1000);

const generateRoomCode = () => {
    let result = '';
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 4; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
};

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('create_room', (data, callback) => {
        let name = data.playerName?.trim().substring(0, 15) || 'PLAYER';
        
        let code = generateRoomCode();
        while(rooms[code]) code = generateRoomCode(); // Ensure unique

        const newRoom = {
            id: code,
            createdAt: Date.now(),
            hostId: socket.id,
            players: [
                { id: socket.id, name: name, isHost: true }
            ],
            settings: {
                timeMinutes: 5,
                spiesCount: 1,
                categoryId: 'random'
            },
            status: 'lobby', // lobby, setup, reveal, timer, voting, results
            gameData: {
                secretWord: null,
                categoryName: null,
                startedAt: null,
                votes: {} // voterId: accusedId
            }
        };

        rooms[code] = newRoom;
        socket.join(code);
        console.log(`Room created: ${code} by ${data.playerName}`);
        
        callback({ success: true, room: newRoom });
    });

    socket.on('join_room', (data, callback) => {
        const roomCode = data.roomCode?.toUpperCase();
        let name = data.playerName?.trim().substring(0, 15) || 'PLAYER';
        const room = rooms[roomCode];

        if (!room) {
            return callback({ success: false, message: 'Room not found' });
        }
        if (room.status !== 'lobby' && room.status !== 'results') {
            return callback({ success: false, message: 'Game already in progress' });
        }
        if (room.players.find(p => p.name === name)) {
            return callback({ success: false, message: 'Name already taken in this room' });
        }

        const newPlayer = { id: socket.id, name: name, isHost: false };
        room.players.push(newPlayer);
        socket.join(roomCode);

        // Broadcast to everyone else in room
        socket.to(roomCode).emit('room_updated', room);
        console.log(`${name} joined ${roomCode}`);
        
        callback({ success: true, room: room });
    });

    socket.on('update_settings', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.settings = { ...room.settings, ...data.settings };
            io.to(roomCode).emit('room_updated', room);
        }
    });

    socket.on('start_game', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            // Assign roles
            const playersCount = room.players.length;
            const spiesCount = Math.min(room.settings.spiesCount, playersCount - 1);
            
            let roles = Array(playersCount).fill('civilian');
            for (let i = 0; i < spiesCount; i++) roles[i] = 'spy';
            roles.sort(() => Math.random() - 0.5);

            room.players.forEach((p, index) => {
                p.role = roles[index];
                p.isSpy = roles[index] === 'spy';
            });

            room.gameData.secretWord = data.secretWord; // Sent by host from categories DB
            room.gameData.categoryName = data.categoryName;
            room.gameData.votes = {};
            room.status = 'reveal'; // push to reveal screen

            io.to(roomCode).emit('room_updated', room);
            // also trigger a hard start event
            io.to(roomCode).emit('game_started'); 
        }
    });

    socket.on('set_status', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.status = data.status;
            if (data.status === 'timer') {
                room.gameData.startedAt = Date.now();
            }
            io.to(roomCode).emit('room_updated', room);
        }
    });

    socket.on('submit_vote', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        room.gameData.votes[socket.id] = data.accusedId;

        // Check if everyone voted
        if (Object.keys(room.gameData.votes).length === room.players.length) {
            room.status = 'results';
        }
        
        io.to(roomCode).emit('room_updated', room);
    });

    socket.on('play_again', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        if (room && room.hostId === socket.id) {
            room.status = 'lobby';
            room.gameData = { secretWord: null, categoryName: null, startedAt: null, votes: {} };
            room.players.forEach(p => { p.role = null; p.isSpy = false; });
            io.to(roomCode).emit('room_updated', room);
        }
    });

    socket.on('leave_room', (data) => {
        handleDisconnect(socket);
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });
});

const handleDisconnect = (socket) => {
    // Find room where user is
    for (const [code, room] of Object.entries(rooms)) {
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            const player = room.players[playerIndex];
            room.players.splice(playerIndex, 1);
            socket.leave(code);
            console.log(`${player.name} left ${code}`);

            if (room.players.length === 0) {
                // Destroy room
                delete rooms[code];
                console.log(`Room ${code} destroyed`);
            } else if (room.hostId === socket.id) {
                // Pass host
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
                io.to(code).emit('room_updated', room);
            } else {
                io.to(code).emit('room_updated', room);
            }
            break;
        }
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Spy Game Multiplayer Server running on port ${PORT}`);
});
