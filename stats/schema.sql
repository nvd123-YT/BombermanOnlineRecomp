-- Bomberman Online DCNet statistics. Raw usernames are never stored.
CREATE TABLE IF NOT EXISTS players (
  player_key TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  total_sessions INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS player_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_player_started ON player_sessions(player_key,started_at DESC);
CREATE TABLE IF NOT EXISTS daily_players (
  day TEXT NOT NULL,
  player_key TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY(day,player_key)
);
CREATE INDEX IF NOT EXISTS idx_daily_players_day ON daily_players(day);
CREATE TABLE IF NOT EXISTS player_snapshots (
  captured_at TEXT PRIMARY KEY,
  online_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collector_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);