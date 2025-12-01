export type Vec2 = {
  x: number;
  y: number;
};

export type CarromCoinColor = "white" | "black" | "queen";

export interface CarromCoin {
  id: string;
  color: CarromCoinColor;
  owner: "A" | "B" | null; // null for queen
  position: Vec2;
  velocity: Vec2;
  radius: number;
  pocketed: boolean;
}

export interface CarromStriker {
  position: Vec2;
  velocity: Vec2;
  radius: number;
}

export type CarromPlayerId = "A" | "B";

export interface CarromPlayerState {
  id: CarromPlayerId;
  username: string;
  colorSet: "white" | "black";
  score: number;
  fouls: number;
  coinsPocketed: number;
  queenCovered: boolean;
}

export type CarromTurnPhase = "aiming" | "moving" | "resolving";

export interface CarromBoardState {
  roomCode: string;
  coins: CarromCoin[];
  striker: CarromStriker;
  currentPlayer: CarromPlayerId;
  players: Record<CarromPlayerId, CarromPlayerState>;
  breakDone: boolean;
  pendingQueenCoverFor: CarromPlayerId | null;
  turnPhase: CarromTurnPhase;
  boardNumber: number;
  maxBoards: number;
  winnerPlayer: CarromPlayerId | null; // winner of the whole match (after N boards)
}

export interface CarromShotPayload {
  angle: number; // radians, 0 = right, pi/2 = up
  power: number; // 0..1 normalized power
  baselineX: number; // 0..1, where along the baseline the striker was placed
}
