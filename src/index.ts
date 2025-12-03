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

  type GameKey = "chess" | "tictactoe" | "connect4";

  const roomPlayers = new Map<string, RoomPlayer[]>();
  const roomGames = new Map<string, GameKey>();

  function parseGameKey(value: string | null | undefined): GameKey | null {
    const v = (value || "").trim();
    if (v === "chess" || v === "tictactoe" || v === "connect4") return v;
    return null;
  }

  function getOrSetRoomGame(
    roomCode: string,
    suggestedGameKey?: string | null,
  ): GameKey {
    const existing = roomGames.get(roomCode);
    if (existing) return existing;
    const parsed = parseGameKey(suggestedGameKey ?? null);
    const resolved: GameKey = parsed ?? "chess";
    roomGames.set(roomCode, resolved);
    return resolved;
  }

  // In-memory chess state per room. For a production setup you could
  // persist this in MongoDB keyed by roomCode.
  const chessGames = new Map<string, Chess>();

  // In-memory Tic Tac Toe state per room.
  type TttCell = "X" | "O" | null;
  interface TttState {
    board: TttCell[];
    next: "X" | "O" | null;
    winner: "X" | "O" | "draw" | null;
  }
  const tttGames = new Map<string, TttState>();

  // In-memory Connect Four state per room.
  type C4Cell = "R" | "Y" | null;
  interface C4State {
    // 7 columns x 6 rows board, stored column-major: index = col * 6 + row.
    board: C4Cell[];
    next: "R" | "Y" | null;
    winner: "R" | "Y" | "draw" | null;
  }
  const c4Games = new Map<string, C4State>();

  function getOrCreateTttState(roomCode: string): TttState {
    const existing = tttGames.get(roomCode);
    if (existing) return existing;
    const fresh: TttState = {
      board: Array(9).fill(null),
      next: "X",
      winner: null,
    };
    tttGames.set(roomCode, fresh);
    return fresh;
  }

  function computeTttWinner(board: TttCell[]): TttState["winner"] {
    const lines = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ];
    for (const [a, b, c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return board[a];
      }
    }
    if (board.every((c) => c)) return "draw";
    return null;
  }

  function getOrCreateC4State(roomCode: string): C4State {
    const existing = c4Games.get(roomCode);
    if (existing) return existing;
    const fresh: C4State = {
      board: Array(7 * 6).fill(null),
      next: "R",
      winner: null,
    };
    c4Games.set(roomCode, fresh);
    return fresh;
  }

  function computeC4Winner(board: C4Cell[]): C4State["winner"] {
    const width = 7;
    const height = 6;
    const directions = [
      { dx: 1, dy: 0 }, // horizontal
      { dx: 0, dy: 1 }, // vertical
      { dx: 1, dy: 1 }, // diag down-right
      { dx: 1, dy: -1 }, // diag up-right
    ];

    const get = (x: number, y: number): C4Cell | null => {
      if (x < 0 || x >= width || y < 0 || y >= height) return null;
      return board[x * height + y];
    };

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const cell = get(x, y);
        if (!cell) continue;
        for (const { dx, dy } of directions) {
          let count = 1;
          for (let step = 1; step < 4; step++) {
            const nx = x + dx * step;
            const ny = y + dy * step;
            if (get(nx, ny) === cell) {
              count++;
            } else {
              break;
            }
          }
          if (count >= 4) {
            return cell;
          }
        }
      }
    }

    if (board.every((c) => c)) return "draw";
    return null;
  }

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

    socket.on(
      "join_room",
      (roomCode: string, username: string, gameKeyRaw?: string | null) => {
        roomCode = (roomCode || "").trim().toUpperCase();
        if (!roomCode || roomCode.length !== 6) return;

        socket.join(roomCode);
        socket.data.username = username;
        socket.data.roomCode = roomCode;

        // Determine the canonical game for this room and notify this socket.
        const roomGame = getOrSetRoomGame(roomCode, gameKeyRaw ?? null);
        socket.emit("room_game", { game: roomGame });

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
        existingPlayers: current.map(p => ({ id: p.id, color: p.color })),
      });

      // Assign chess colors: first player in the room becomes white, second becomes black.
      // If this socket is reconnecting and already has a color, keep it.
      const existingForSocket = current.find((p) => p.id === socket.id);
      const existingForUsername = current.find(
        (p) => p.usernameNormalized === normalizedUsername,
      );
      let color: RoomPlayerColor = existingForSocket?.color ?? existingForUsername?.color ?? null;

      if (!color) {
        // This is a new join (not a reconnect). Assign color based on room size.
        const takenColors = new Set<RoomPlayerColor>(
          withoutDuplicateUser.map((p) => p.color),
        );
        console.log(`[${roomCode}] Assigning new color. Taken colors:`, Array.from(takenColors));
        if (!takenColors.has("w")) {
          color = "w"; // First player
          console.log(`[${roomCode}] Assigned WHITE to ${username}`);
        } else if (!takenColors.has("b")) {
          color = "b"; // Second player
          console.log(`[${roomCode}] Assigned BLACK to ${username}`);
        } else {
          console.log(`[${roomCode}] Room is FULL. ${username} joins as spectator (null color)`);
        }
        // If both colors are taken, color remains null (spectator, but we'll reject on client).
      } else {
        console.log(`[${roomCode}] ${username} reconnecting with existing color: ${color}`);
      }

      // Ludo roles removed but kept in data structure for compatibility.
      const ludoIndex: number | null =
        existingForSocket?.ludoIndex ?? existingForUsername?.ludoIndex ?? null;

      const updatedPlayers: RoomPlayer[] = [
        ...withoutDuplicateUser,
        { id: socket.id, username, usernameNormalized: normalizedUsername, color, ludoIndex },
      ];
      roomPlayers.set(roomCode, updatedPlayers);

      io.to(roomCode).emit("system", `${username} joined room ${roomCode}`);
      broadcastPlayers(roomCode);

      // Tell this socket which chess color / ttt symbol / ludo index it controls (if any).
      socket.emit("chess_role", { color });

      // Tic Tac Toe: first active player is X, second is O.
      const orderedForTtt = updatedPlayers.filter((p) => p.usernameNormalized);
      const xId = orderedForTtt[0]?.id;
      const oId = orderedForTtt[1]?.id;
      let tttSymbol: "X" | "O" | null = null;
      if (socket.id === xId) tttSymbol = "X";
      else if (socket.id === oId) tttSymbol = "O";
      socket.emit("tictactoe_role", { symbol: tttSymbol });

      // Connect Four: first active player is Red (R), second is Yellow (Y).
      const orderedForC4 = orderedForTtt;
      const rId = orderedForC4[0]?.id;
      const yId = orderedForC4[1]?.id;
      let c4Symbol: "R" | "Y" | null = null;
      if (socket.id === rId) c4Symbol = "R";
      else if (socket.id === yId) c4Symbol = "Y";
      socket.emit("connect4_role", { symbol: c4Symbol });

      socket.emit("ludo_role", { index: ludoIndex });

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

    // Carrom: basic synchronized state with server as authority for turns.
    // (Carrom game removed)

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

    // Tic Tac Toe: simple 3x3 board with X/O turns.
    socket.on("tictactoe_move", (roomCode: string, index: number) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const game = getOrCreateTttState(roomCode);
      if (game.winner || game.next == null) return;
      if (index < 0 || index > 8) return;
      if (game.board[index]) return;

      const playersInRoom = roomPlayers.get(roomCode) || [];
      const me = playersInRoom.find((p) => p.id === socket.id);
      if (!me) return;

      const mySymbol: "X" | "O" | null = (() => {
        // First player in room is X, second is O.
        const ordered = playersInRoom.filter((p) => p.usernameNormalized);
        const xId = ordered[0]?.id;
        const oId = ordered[1]?.id;
        if (socket.id === xId) return "X";
        if (socket.id === oId) return "O";
        return null;
      })();

      if (!mySymbol || mySymbol !== game.next) return;

      game.board[index] = mySymbol;
      game.winner = computeTttWinner(game.board);
      game.next = game.winner ? null : mySymbol === "X" ? "O" : "X";

      io.to(roomCode).emit("tictactoe_state", game);
    });

    socket.on("tictactoe_request_state", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const game = getOrCreateTttState(roomCode);
      socket.emit("tictactoe_state", game);
    });

    socket.on("tictactoe_reset", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const fresh = getOrCreateTttState(roomCode);
      fresh.board = Array(9).fill(null);
      fresh.next = "X";
      fresh.winner = null;
      io.to(roomCode).emit("tictactoe_state", fresh);
    });

    // Connect Four: 7x6 vertical grid with gravity.
    socket.on("connect4_move", (roomCode: string, colIndex: number) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      if (colIndex < 0 || colIndex > 6) return;
      const game = getOrCreateC4State(roomCode);
      if (game.winner || game.next == null) return;

      const playersInRoom = roomPlayers.get(roomCode) || [];
      const me = playersInRoom.find((p) => p.id === socket.id);
      if (!me) return;

      const mySymbol: "R" | "Y" | null = (() => {
        // First player is R, second is Y.
        const ordered = playersInRoom.filter((p) => p.usernameNormalized);
        const rId = ordered[0]?.id;
        const yId = ordered[1]?.id;
        if (socket.id === rId) return "R";
        if (socket.id === yId) return "Y";
        return null;
      })();

      if (!mySymbol || mySymbol !== game.next) return;

      const width = 7;
      const height = 6;
      const board = game.board;
      // Find lowest empty slot in the selected column.
      let placedRow: number | null = null;
      for (let row = 0; row < height; row++) {
        const idx = colIndex * height + row;
        if (!board[idx]) {
          board[idx] = mySymbol;
          placedRow = row;
          break;
        }
      }
      if (placedRow == null) return; // column full

      game.winner = computeC4Winner(board);
      game.next = game.winner ? null : mySymbol === "R" ? "Y" : "R";

      io.to(roomCode).emit("connect4_state", game);
    });

    socket.on("connect4_request_state", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const game = getOrCreateC4State(roomCode);
      socket.emit("connect4_state", game);
    });

    socket.on("connect4_reset", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const fresh = getOrCreateC4State(roomCode);
      fresh.board = Array(7 * 6).fill(null);
      fresh.next = "R";
      fresh.winner = null;
      io.to(roomCode).emit("connect4_state", fresh);
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

        io.to(roomCode).emit("chess_position", { fen: game.fen() });
      },
    );

    socket.on("chess_request_state", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const existing = chessGames.get(roomCode);
      if (existing) {
        socket.emit("chess_position", { fen: existing.fen() });
      }
    });

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

        // Resolve the canonical game for this room based on any existing mapping
        // or the requested config, then broadcast it.
        const resolved = getOrSetRoomGame(roomCode, config?.game ?? null);

        io.to(roomCode).emit("room_game", { game: resolved });
        io.to(roomCode).emit("game_started", { ...config, game: resolved });
      },
    );

    socket.on("disconnect", () => {
      const roomCode = (socket.data.roomCode as string | undefined) || "";
      if (roomCode && roomPlayers.has(roomCode)) {
        const current = roomPlayers.get(roomCode) || [];
        const updated = current.filter((p) => p.id !== socket.id);
        if (updated.length === 0) {
          roomPlayers.delete(roomCode);
          // Clean up any in-memory game state when a room is fully empty.
          chessGames.delete(roomCode);
          tttGames.delete(roomCode);
          c4Games.delete(roomCode);
          roomGames.delete(roomCode);
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
