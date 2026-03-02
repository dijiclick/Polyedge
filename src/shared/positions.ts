import { readFileSync, writeFileSync, existsSync } from 'fs';

const FILE = process.env.POSITIONS_FILE || '/tmp/pm-positions.json';

export interface Position {
  id:           string;
  tokenId:      string;
  question:     string;
  side:         'YES' | 'NO';
  strategy:     'oracle-arb' | 'edge-ai' | 'crypto-oracle' | 'live-score' | 'odds-arb';
  shares:       number;
  entryPrice:   number;
  usdcSpent:    number;
  entryTime:    number;
  orderId:      string;
  status:       'open' | 'sold' | 'resolved' | 'expired';
  dryRun:       boolean;
  aiConfidence?: number;
  aiReasoning?:  string;
}

export function loadPositions(): Position[] {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
}

export function savePositions(positions: Position[]): void {
  writeFileSync(FILE, JSON.stringify(positions, null, 2));
}

export function addPosition(pos: Position): void {
  const all = loadPositions();
  all.push(pos);
  savePositions(all);
}

export function updatePosition(id: string, updates: Partial<Position>): void {
  const all = loadPositions();
  const idx = all.findIndex(p => p.id === id);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...updates };
    savePositions(all);
  }
}

export function getOpenPositions(): Position[] {
  return loadPositions().filter(p => p.status === 'open');
}
