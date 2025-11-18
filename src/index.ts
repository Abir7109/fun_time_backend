import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Chess } from "chess.js";

dotenv.config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const MONGODB_URI = process.env.MONGODB_URI;

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn("MONGODB_URI not set - skipping MongoDB connection.");
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}

async function main() {
  await connectMongo();

  const app = express();
  app.use(cors({ origin: CLIENT_ORIGIN }));
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: CLIENT_ORIGIN,
    },
  });

  type RoomPlayer = { id: string; username: string };
  const roomPlayers = new Map<string, RoomPlayer[]>();

  // In-memory chess state per room. For a production setup you could
  // persist this in MongoDB keyed by roomCode.
  const chessGames = new Map<string, Chess>();

  function broadcastPlayers(roomCode: string) {
    const players = roomPlayers.get(roomCode) || [];
    io.to(roomCode).emit("room_players", players);
  }

  function getOrCreateChessGame(roomCode: string): Chess {
    const existing = chessGames.get(roomCode);
    if (existing) return existing;
    const fresh = new Chess();
    chessGames.set(roomCode, fresh);
    return fresh;
  }

  io.on("connection", (socket) => {
    console.log("🔌 client connected", socket.id);

    socket.on("join_room", (roomCode: string, username: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;

      socket.join(roomCode);
      socket.data.username = username;
      socket.data.roomCode = roomCode;

      const current = roomPlayers.get(roomCode) || [];
      const withoutThis = current.filter((p) => p.id !== socket.id);
      roomPlayers.set(roomCode, [...withoutThis, { id: socket.id, username }]);

      io.to(roomCode).emit("system", `${username} joined room ${roomCode}`);
      broadcastPlayers(roomCode);

      // If there is an existing chess game for this room, send the current
      // position to the newly joined client so they see the live board.
      const existingGame = chessGames.get(roomCode);
      if (existingGame) {
        socket.emit("chess_position", { fen: existingGame.fen() });
      }
    });

    socket.on("chat", (roomCode: string, msg: string) => {
      io.to(roomCode).emit("chat", { from: socket.data.username, msg });
    });

    // Chess synchronization: server holds a Chess instance per room and
    // applies moves sent by clients, then broadcasts the resulting FEN.
    socket.on(
      "chess_move",
      (
        roomCode: string,
        payload: { from: string; to: string; promotion?: string } | null,
      ) => {
        roomCode = (roomCode || "").trim().toUpperCase();
        if (!roomCode || roomCode.length !== 6 || !payload) return;

        const game = getOrCreateChessGame(roomCode);
        try {
          const move = game.move({
            from: payload.from,
            to: payload.to,
            promotion: payload.promotion || "q",
          } as any);
          if (!move) {
            socket.emit("chess_invalid", payload);
            return;
          }
        } catch (_err) {
          socket.emit("chess_invalid", payload);
          return;
        }

        io.to(roomCode).emit("chess_position", { fen: game.fen() });
      },
    );

    socket.on("chess_reset", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const fresh = new Chess();
      chessGames.set(roomCode, fresh);
      io.to(roomCode).emit("chess_position", { fen: fresh.fen() });
    });

    socket.on(
      "start_game",
      (roomCode: string, config?: { players?: number; game?: string }) => {
        roomCode = (roomCode || "").trim().toUpperCase();
        if (!roomCode || roomCode.length !== 6) return;
        io.to(roomCode).emit("game_started", config);
      },
    );

    socket.on("disconnect", () => {
      const roomCode = (socket.data.roomCode as string | undefined) || "";
      if (roomCode && roomPlayers.has(roomCode)) {
        const current = roomPlayers.get(roomCode) || [];
        const updated = current.filter((p) => p.id !== socket.id);
        if (updated.length === 0) {
          roomPlayers.delete(roomCode);
        } else {
          roomPlayers.set(roomCode, updated);
        }
        broadcastPlayers(roomCode);
      }
      console.log("❌ client disconnected", socket.id);
    });
  });

  server.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
