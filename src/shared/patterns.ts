import { readFileSync, writeFileSync, existsSync } from 'fs';

const FILE = process.env.PATTERNS_FILE || '/tmp/pm-patterns.json';

export type EventType =
  | 'soccer_match'
  | 'basketball_game'
  | 'american_football'
  | 'election'
  | 'crypto_price'
  | 'sports_award'
  | 'weather'
  | 'general';

export const EVENT_TYPES: EventType[] = [
  'soccer_match', 'basketball_game', 'american_football',
  'election', 'crypto_price', 'sports_award', 'weather', 'general',
];

export interface HistoryEntry {
  question:         string;
  predictedOutcome: string;
  actualOutcome:    string | null;
  confidence:       number;
  correct:          boolean | null;
  timestamp:        number;
}

export interface EventPattern {
  wins:         number;
  total:        number;
  lastAccuracy: number;
  history:      HistoryEntry[];
}

export type PatternMemory = Record<EventType, EventPattern>;

function emptyPattern(): EventPattern {
  return { wins: 0, total: 0, lastAccuracy: 0.5, history: [] };
}

export function initPatterns(): PatternMemory {
  const m = {} as PatternMemory;
  for (const t of EVENT_TYPES) m[t] = emptyPattern();
  return m;
}

export function loadPatterns(): PatternMemory {
  if (!existsSync(FILE)) return initPatterns();
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as PatternMemory;
    // fill missing keys
    for (const t of EVENT_TYPES) { if (!raw[t]) raw[t] = emptyPattern(); }
    return raw;
  } catch { return initPatterns(); }
}

export function savePatterns(p: PatternMemory): void {
  writeFileSync(FILE, JSON.stringify(p, null, 2));
}

export function recordPrediction(opts: {
  eventType:        EventType;
  question:         string;
  predictedOutcome: string;
  confidence:       number;
}): void {
  const mem = loadPatterns();
  mem[opts.eventType].history.push({
    question:         opts.question,
    predictedOutcome: opts.predictedOutcome,
    actualOutcome:    null,
    confidence:       opts.confidence,
    correct:          null,
    timestamp:        Date.now(),
  });
  // Keep last 50 entries per type
  if (mem[opts.eventType].history.length > 50) {
    mem[opts.eventType].history = mem[opts.eventType].history.slice(-50);
  }
  savePatterns(mem);
}

export function updatePredictionResult(opts: {
  eventType:     EventType;
  question:      string;
  actualOutcome: string;
}): void {
  const mem = loadPatterns();
  const pat = mem[opts.eventType];
  // Find most recent unresolved prediction for this question
  const entry = [...pat.history].reverse().find(
    h => h.question === opts.question && h.correct === null
  );
  if (!entry) return;
  entry.actualOutcome = opts.actualOutcome;
  entry.correct       = entry.predictedOutcome === opts.actualOutcome;
  pat.total += 1;
  if (entry.correct) pat.wins += 1;
  pat.lastAccuracy = pat.total > 0 ? pat.wins / pat.total : 0.5;
  savePatterns(mem);
}

export function getAccuracy(eventType: EventType): number {
  const mem = loadPatterns();
  const pat = mem[eventType];
  return pat.total > 0 ? pat.lastAccuracy : 0.5;
}

export function getAccuracySummary(): string {
  const mem = loadPatterns();
  return EVENT_TYPES
    .filter(t => mem[t].total > 0)
    .map(t => {
      const p = mem[t];
      return `${t}: ${(p.lastAccuracy * 100).toFixed(0)}% (${p.wins}/${p.total})`;
    })
    .join(', ') || 'No history yet';
}
