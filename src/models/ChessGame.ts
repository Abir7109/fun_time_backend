import mongoose, { Schema, Document, Model } from "mongoose";

export interface IChessGame extends Document {
  roomCode: string;
  fen: string;
  whiteUsername?: string | null;
  blackUsername?: string | null;
  updatedAt: Date;
}

const ChessGameSchema = new Schema<IChessGame>(
  {
    roomCode: { type: String, required: true, unique: true, index: true },
    fen: { type: String, required: true },
    whiteUsername: { type: String, default: null },
    blackUsername: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const ChessGame: Model<IChessGame> =
  mongoose.models.ChessGame || mongoose.model<IChessGame>("ChessGame", ChessGameSchema);
