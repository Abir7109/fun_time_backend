import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Chess } from "chess.js";
import type {
  CarromBoardState,
  CarromPlayerId,
  CarromShotPayload,
  CarromCoin,
  Vec2,
} from "./carromTypes";

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

  // In-memory Carrom state per room.
  const carromGames = new Map<string, CarromBoardState>();

  const BOARD_SIZE = 1; // normalized 0..1
  const STRIKER_RADIUS = 0.035;
  const COIN_RADIUS = 0.025;
  const POCKET_RADIUS = 0.07;

  function v(x: number, y: number): Vec2 {
    return { x, y };
  }

  function dist2(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  const POCKETS: Vec2[] = [
    v(0.02, 0.02),
    v(0.98, 0.02),
    v(0.02, 0.98),
    v(0.98, 0.98),
  ];

  function createInitialCarromCoins(roomCode: string): CarromCoin[] {
    const coins: CarromCoin[] = [];
    const center = v(0.5, 0.5);
    const offsets: Vec2[] = [
      v(0, 0),
      v(COIN_RADIUS * 2, 0),
      v(-COIN_RADIUS * 2, 0),
      v(0, COIN_RADIUS * 2),
      v(0, -COIN_RADIUS * 2),
      v(COIN_RADIUS * 1.6, COIN_RADIUS * 1.6),
      v(-COIN_RADIUS * 1.6, COIN_RADIUS * 1.6),
      v(COIN_RADIUS * 1.6, -COIN_RADIUS * 1.6),
      v(-COIN_RADIUS * 1.6, -COIN_RADIUS * 1.6),
    ];

    // Queen in exact center.
    coins.push({
      id: `${roomCode}-queen`,
      color: "queen",
      owner: null,
      position: center,
      velocity: v(0, 0),
      radius: COIN_RADIUS,
      pocketed: false,
    });

    // Nine white, nine black around.
    for (let i = 0; i < 9; i++) {
      const off = offsets[i % offsets.length];
      const baseId = `${roomCode}-coin-${i}`;
      const white: CarromCoin = {
        id: `${baseId}-w`,
        color: "white",
        owner: "A",
        position: v(center.x + off.x * 0.6, center.y + off.y * 0.6),
        velocity: v(0, 0),
        radius: COIN_RADIUS,
        pocketed: false,
      };
      const black: CarromCoin = {
        id: `${baseId}-b`,
        color: "black",
        owner: "B",
        position: v(center.x + off.x * 1.1, center.y + off.y * 1.1),
        velocity: v(0, 0),
        radius: COIN_RADIUS,
        pocketed: false,
      };
      coins.push(white, black);
    }

    return coins;
  }

  function getOrCreateCarromState(roomCode: string, players: RoomPlayer[]): CarromBoardState {
    const existing = carromGames.get(roomCode);
    if (existing) return existing;

    const pAId: CarromPlayerId = "A";
    const pBId: CarromPlayerId = "B";
    const firstTwo = players.slice(0, 2);
    const nameA = firstTwo[0]?.username || "Player A";
    const nameB = firstTwo[1]?.username || "Player B";

    const coins = createInitialCarromCoins(roomCode);

    const state: CarromBoardState = {
      roomCode,
      coins,
      striker: {
        position: v(0.5, 0.1),
        velocity: v(0, 0),
        radius: STRIKER_RADIUS,
      },
      currentPlayer: pAId,
      players: {
        [pAId]: {
          id: pAId,
          username: nameA,
          colorSet: "white",
          score: 0,
          fouls: 0,
          coinsPocketed: 0,
          queenCovered: false,
        },
        [pBId]: {
          id: pBId,
          username: nameB,
          colorSet: "black",
          score: 0,
          fouls: 0,
          coinsPocketed: 0,
          queenCovered: false,
        },
      },
      breakDone: false,
      pendingQueenCoverFor: null,
      turnPhase: "aiming",
      boardNumber: 1,
      maxBoards: 8,
      winnerPlayer: null,
    };

    carromGames.set(roomCode, state);
    return state;
  }

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
    socket.on("carrom_request_state", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const playersInRoom = roomPlayers.get(roomCode) || [];
      const state = getOrCreateCarromState(roomCode, playersInRoom);
      socket.emit("carrom_state", state);
    });

    socket.on("carrom_shot", (roomCode: string, payload: CarromShotPayload | null) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6 || !payload) return;
      const playersInRoom = roomPlayers.get(roomCode) || [];
      const state = getOrCreateCarromState(roomCode, playersInRoom);

      const meIdx = playersInRoom.findIndex((p) => p.id === socket.id);
      if (meIdx === -1) return;
      const myId: CarromPlayerId = meIdx === 0 ? "A" : meIdx === 1 ? "B" : null as any;
      if (!myId || state.currentPlayer !== myId || state.turnPhase !== "aiming") return;

      const angle = payload.angle;
      const power = Math.max(0, Math.min(1, payload.power));
      const speed = 1.8 * power; // tuned later
      state.striker.position = { x: payload.baselineX, y: myId === "A" ? 0.1 : 0.9 };
      state.striker.velocity = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
      state.turnPhase = "moving";

      const dt = 0.016;
      const friction = 0.985;
      const steps = 260;
      const shotPocketed: CarromCoin[] = [];
      let strikerPocketed = false;

      for (let i = 0; i < steps; i++) {
        // Advance striker.
        state.striker.position.x += state.striker.velocity.x * dt;
        state.striker.position.y += state.striker.velocity.y * dt;
        state.striker.velocity.x *= friction;
        state.striker.velocity.y *= friction;

        // Bounce off walls.
        if (
          state.striker.position.x - STRIKER_RADIUS < 0 ||
          state.striker.position.x + STRIKER_RADIUS > BOARD_SIZE
        ) {
          state.striker.velocity.x *= -0.7;
        }
        if (
          state.striker.position.y - STRIKER_RADIUS < 0 ||
          state.striker.position.y + STRIKER_RADIUS > BOARD_SIZE
        ) {
          state.striker.velocity.y *= -0.7;
        }

        // Striker-pocket detection.
        if (!strikerPocketed) {
          for (const p of POCKETS) {
            if (dist2(state.striker.position, p) < POCKET_RADIUS * POCKET_RADIUS) {
              strikerPocketed = true;
              state.striker.velocity = v(0, 0);
              break;
            }
          }
        }

        // Advance coins.
        for (const coin of state.coins) {
          if (coin.pocketed) continue;
          // Simple collision with striker.
          const dx = coin.position.x - state.striker.position.x;
          const dy = coin.position.y - state.striker.position.y;
          const rSum = coin.radius + STRIKER_RADIUS;
          const d2 = dx * dx + dy * dy;
          if (d2 > 0 && d2 < rSum * rSum) {
            const d = Math.sqrt(d2);
            const nx = dx / d;
            const ny = dy / d;
            const relVx = state.striker.velocity.x;
            const relVy = state.striker.velocity.y;
            const relDot = relVx * nx + relVy * ny;
            if (relDot > 0) {
              const impulse = relDot;
              coin.velocity.x += nx * impulse * 0.8;
              coin.velocity.y += ny * impulse * 0.8;
              state.striker.velocity.x -= nx * impulse * 0.6;
              state.striker.velocity.y -= ny * impulse * 0.6;
            }
          }

          // Move coin.
          coin.position.x += coin.velocity.x * dt;
          coin.position.y += coin.velocity.y * dt;
          coin.velocity.x *= friction;
          coin.velocity.y *= friction;

          // Wall bounce for coins.
          if (
            coin.position.x - COIN_RADIUS < 0 ||
            coin.position.x + COIN_RADIUS > BOARD_SIZE
          ) {
            coin.velocity.x *= -0.7;
          }
          if (
            coin.position.y - COIN_RADIUS < 0 ||
            coin.position.y + COIN_RADIUS > BOARD_SIZE
          ) {
            coin.velocity.y *= -0.7;
          }

          // Pocket detection for coins.
          for (const p of POCKETS) {
            if (dist2(coin.position, p) < POCKET_RADIUS * POCKET_RADIUS) {
              coin.pocketed = true;
              coin.velocity = v(0, 0);
              shotPocketed.push(coin);
              break;
            }
          }
        }
      }

      state.turnPhase = "resolving";

      const mePlayer = state.players[myId];
      const otherId: CarromPlayerId = myId === "A" ? "B" : "A";
      const otherPlayer = state.players[otherId];

      let ownPocketedThisShot = 0;
      let oppPocketedThisShot = 0;
      let queenPocketedThisShot = false;

      for (const coin of shotPocketed) {
        if (coin.color === "queen") {
          queenPocketedThisShot = true;
          state.pendingQueenCoverFor = myId;
        } else if (coin.owner === myId) {
          ownPocketedThisShot++;
          mePlayer.coinsPocketed += 1;
          mePlayer.score += 1;
        } else if (coin.owner === otherId) {
          oppPocketedThisShot++;
          otherPlayer.coinsPocketed += 1;
          otherPlayer.score += 1;
        }
      }

      // Queen cover logic.
      if (state.pendingQueenCoverFor === myId) {
        if (ownPocketedThisShot > 0) {
          mePlayer.queenCovered = true;
          mePlayer.score += 5;
          state.pendingQueenCoverFor = null;
        }
      }

      // If queen was pending from a previous turn and player failed again, return queen.
      if (state.pendingQueenCoverFor === myId && ownPocketedThisShot === 0 && !queenPocketedThisShot) {
        const queen = state.coins.find((c) => c.color === "queen");
        if (queen) {
          queen.pocketed = false;
          queen.position = v(0.5, 0.5);
          queen.velocity = v(0, 0);
        }
        state.pendingQueenCoverFor = null;
        mePlayer.queenCovered = false;
      }

      // Striker foul.
      if (strikerPocketed) {
        mePlayer.fouls += 1;
        // Return one of player's own pocketed coins (not queen) if any.
        const returned = state.coins.find(
          (c) => c.owner === myId && c.pocketed && c.color !== "queen",
        );
        if (returned) {
          returned.pocketed = false;
          returned.position = v(0.5, 0.5);
          returned.velocity = v(0, 0);
          mePlayer.coinsPocketed = Math.max(0, mePlayer.coinsPocketed - 1);
          mePlayer.score = Math.max(0, mePlayer.score - 1);
        }
      }

      // Determine if player gets another turn.
      let keepTurn = false;
      if (!strikerPocketed && (ownPocketedThisShot > 0 || queenPocketedThisShot)) {
        keepTurn = true;
      }

      if (!keepTurn) {
        state.currentPlayer = otherId;
      }

      // Winner detection: a player with all 9 of their coins pocketed and queen covered.
      const aState = state.players["A"];
      const bState = state.players["B"];
      const aAll = aState.coinsPocketed >= 9 && aState.queenCovered;
      const bAll = bState.coinsPocketed >= 9 && bState.queenCovered;
      if (aAll || bAll) {
        state.winnerPlayer = aAll && !bAll ? "A" : !aAll && bAll ? "B" : null;
      }

      state.turnPhase = "aiming";

      io.to(roomCode).emit("carrom_state", state);
    });

    socket.on("carrom_reset", (roomCode: string) => {
      roomCode = (roomCode || "").trim().toUpperCase();
      if (!roomCode || roomCode.length !== 6) return;
      const playersInRoom = roomPlayers.get(roomCode) || [];
      const fresh = getOrCreateCarromState(roomCode, playersInRoom);
      carromGames.set(roomCode, fresh);
      io.to(roomCode).emit("carrom_state", fresh);
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
