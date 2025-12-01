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

  type RoomPlayerColor = "w" | "b" | null;
  type RoomPlayer = {
    id: string;
    username: string;
    usernameNormalized: string;
    color: RoomPlayerColor;
    ludoIndex: number | null; // 0 = P1, 1 = P2, null = no Ludo role / spectator
  };
  const roomPlayers = new Map<string, RoomPlayer[]>();

  // In-memory chess state per room. We also persist FEN + seat assignments in
  // MongoDB so games survive server restarts and users keep their colors.
  const chessGames = new Map<string, Chess>();

  function broadcastPlayers(roomCode: string) {
    const players = roomPlayers.get(roomCode) || [];
    io.to(roomCode).emit("room_players", players);
  }

  async function getOrCreateChessGame(roomCode: string): Promise<Chess> {
    const cached = chessGames.get(roomCode);
    if (cached) return cached;

    // Try to load from Mongo first so we retain state across server restarts.
    const { ChessGame } = await import("./models/ChessGame");
    const existingDoc = await ChessGame.findOne({ roomCode }).lean();

    const game = existingDoc ? new Chess(existingDoc.fen) : new Chess();
    chessGames.set(roomCode, game);

    // Ensure there is a DB record for this room so future restarts can resume.
    if (!existingDoc) {
      await ChessGame.create({ roomCode, fen: game.fen() });
    }

    return game;
  }

  async function persistChessFen(roomCode: string, game: Chess): Promise<void> {
    const { ChessGame } = await import("./models/ChessGame");
    await ChessGame.findOneAndUpdate(
      { roomCode },
      { $set: { fen: game.fen() } },
      { upsert: true },
    );
  }

  io.on("connection", (socket) => {
    console.log("🔌 client connected", socket.id);

    socket.on("join_room", async (roomCode: string, username: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;

      socket.join(roomCode);
      socket.data.username = username;
      socket.data.roomCode = roomCode;

      const normalizedUsername = username.trim().toLowerCase();

      const current = roomPlayers.get(roomCode) || [];
      const withoutThis = current.filter((p) => p.id !== socket.id);
      const withoutDuplicateUser = withoutThis.filter(
        (p) => p.usernameNormalized !== normalizedUsername,
      );

      console.log(`[${roomCode}] Player joining:`, {
        socketId: socket.id,
        username,
        currentPlayersCount: current.length,
        playersWithoutThis: withoutThis.length,
        existingPlayers: current.map((p) => ({ id: p.id, color: p.color })),
      });

      // Load or create persistent chess game + seat info.
      const { ChessGame } = await import("./models/ChessGame");
      const gameDoc =
        (await ChessGame.findOne({ roomCode })) ||
        (await ChessGame.create({ roomCode, fen: new Chess().fen() }));

      const whiteNameNorm = gameDoc.whiteUsername
        ? gameDoc.whiteUsername.trim().toLowerCase()
        : null;
      const blackNameNorm = gameDoc.blackUsername
        ? gameDoc.blackUsername.trim().toLowerCase()
        : null;

      const connectedNames = new Set(
        current.map((p) => p.usernameNormalized),
      );
      const whiteSeatOccupied =
        whiteNameNorm != null && connectedNames.has(whiteNameNorm);
      const blackSeatOccupied =
        blackNameNorm != null && connectedNames.has(blackNameNorm);

      // Assign chess colors: first player in the room becomes white, second becomes black.
      // If this socket is reconnecting and already has a color, keep it.
      const existingForSocket = current.find((p) => p.id === socket.id);
      const existingForUsername = current.find(
        (p) => p.usernameNormalized === normalizedUsername,
      );
      let color: RoomPlayerColor = existingForSocket?.color ?? existingForUsername?.color ?? null;

      if (!color) {
        // Try to reuse an existing seat from the persistent game by username.
        if (normalizedUsername === whiteNameNorm) {
          color = "w";
        } else if (normalizedUsername === blackNameNorm) {
          color = "b";
        } else if (!whiteSeatOccupied) {
          color = "w";
          gameDoc.whiteUsername = username;
        } else if (!blackSeatOccupied) {
          color = "b";
          gameDoc.blackUsername = username;
        } else {
          console.log(
            `[${roomCode}] Room is FULL. ${username} joins as spectator (null color)`,
          );
        }

        await gameDoc.save();
      } else {
        console.log(
          `[${roomCode}] ${username} reconnecting with existing color: ${color}`,
        );
      }

      // Ludo roles removed but kept in data structure for compatibility.
      const ludoIndex: number | null =
        existingForSocket?.ludoIndex ?? existingForUsername?.ludoIndex ?? null;

      const updatedPlayers: RoomPlayer[] = [
        ...withoutDuplicateUser,
        {
          id: socket.id,
          username,
          usernameNormalized: normalizedUsername,
          color,
          ludoIndex,
        },
      ];
      roomPlayers.set(roomCode, updatedPlayers);

      io.to(roomCode).emit("system", `${username} joined room ${roomCode}`);
      broadcastPlayers(roomCode);

      // Tell this socket which chess color / ludo index it controls (if any).
      socket.emit("chess_role", { color });
      socket.emit("ludo_role", { index: ludoIndex });

      // If there is an existing chess game for this room, send the current
      // position to the newly joined client so they see the live board.
      const game = await getOrCreateChessGame(roomCode);
      socket.emit("chess_position", { fen: game.fen() });
    });

    socket.on("chat", (roomCode: string, msg: string) => {
      io.to(roomCode).emit("chat", { from: socket.data.username, msg });
    });

    // Ludo: clients are authoritative for now and send full state snapshots;
    // the server simply relays them to all sockets in the same room.
    socket.on("ludo_state", (roomCode: string, state: unknown) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6 || !state) return;
      io.to(roomCode).emit("ludo_state", state);
    });

    // Ludo role selection: a client chooses which index (0 or 1) they control.
    // We enforce uniqueness so only one socket can be each player.
    socket.on("ludo_choose_role", (roomCode: string, index: number | null) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;

      const playersInRoom = roomPlayers.get(roomCode) || [];
      const meIndex = playersInRoom.findIndex((p) => p.id === socket.id);
      if (meIndex === -1) return;

      const clampedIndex: number | null = index === 0 || index === 1 ? index : null;

      if (clampedIndex !== null) {
        const takenByOther = playersInRoom.some(
          (p) => p.id !== socket.id && p.ludoIndex === clampedIndex,
        );
        if (takenByOther) {
          // Role already taken; re-send the caller's current role so their UI stays in sync.
          socket.emit("ludo_role", { index: playersInRoom[meIndex].ludoIndex ?? null });
          return;
        }
      }

      playersInRoom[meIndex] = {
        ...playersInRoom[meIndex],
        ludoIndex: clampedIndex,
      };
      roomPlayers.set(roomCode, playersInRoom);
      broadcastPlayers(roomCode);

      socket.emit("ludo_role", { index: clampedIndex });
    });

    // Chess synchronization: server holds a Chess instance per room and
    // applies moves sent by clients, then broadcasts the resulting FEN.
    socket.on(
      "chess_move",
      async (
        roomCode: string,
        payload: { from: string; to: string; promotion?: string } | null,
      ) => {
        roomCode = (roomCode || "").trim().toUpperCase();
        if (!roomCode || roomCode.length !== 6 || !payload) return;

        const game = await getOrCreateChessGame(roomCode);

        // Enforce that only the player whose color is to move can make a move.
        const playersInRoom = roomPlayers.get(roomCode) || [];
        const me = playersInRoom.find((p) => p.id === socket.id);
        const myColor = me?.color ?? null;
        const turn = game.turn() as RoomPlayerColor;
        if (!myColor || myColor !== turn) {
          socket.emit("chess_invalid", payload);
          return;
        }

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

        await persistChessFen(roomCode, game);
        io.to(roomCode).emit("chess_position", { fen: game.fen() });
      },
    );

    socket.on("chess_request_state", async (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const game = await getOrCreateChessGame(roomCode);
      socket.emit("chess_position", { fen: game.fen() });
    });

    socket.on("chess_reset", async (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const fresh = new Chess();
      chessGames.set(roomCode, fresh);
      await persistChessFen(roomCode, fresh);
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
