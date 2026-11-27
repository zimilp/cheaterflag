-- CheaterFlag shared database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS members (
  steamid TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | suspended
  role TEXT NOT NULL DEFAULT 'member',      -- member | admin
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS blacklist (
  steamid TEXT PRIMARY KEY,
  name TEXT,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS overrides (
  steamid TEXT PRIMARY KEY,
  tier TEXT NOT NULL,                        -- approved | limited | rejected
  note TEXT,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (       -- Steam API cache (24 h)
  steamid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (           -- review queue
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_code TEXT NOT NULL,
  steamid TEXT NOT NULL,
  name TEXT,
  category TEXT,
  score INTEGER,
  rounds TEXT,
  signals TEXT,
  map TEXT,
  reporter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | cleared
  reviewed_by TEXT,
  created_at INTEGER NOT NULL,
  extra TEXT,                                -- JSON: moments to watch + demo link
  UNIQUE (share_code, steamid)
);

CREATE TABLE IF NOT EXISTS demo_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | error
  url TEXT,
  error TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flag_votes (      -- members vote on review-queue flags
  flag_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  vote TEXT NOT NULL,                        -- cheater | clean
  created_at INTEGER NOT NULL,
  PRIMARY KEY (flag_id, voter)
);

CREATE TABLE IF NOT EXISTS blacklist_votes ( -- members vote to keep or remove blacklist entries
  steamid TEXT NOT NULL,
  voter TEXT NOT NULL,
  vote TEXT NOT NULL,                        -- keep | remove
  created_at INTEGER NOT NULL,
  PRIMARY KEY (steamid, voter)
);

-- small key/value state (bot heartbeat, last wake-up)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER
);

-- fun stats (Stats tab): one row per member per match
CREATE TABLE IF NOT EXISTS match_stats (
  match_id TEXT NOT NULL,
  steamid TEXT NOT NULL,
  played_at INTEGER,
  map TEXT,
  stats TEXT NOT NULL,
  PRIMARY KEY (match_id, steamid)
);

-- ping from each member's PC to Valve's server regions (team balancer picks a fair server)
CREATE TABLE IF NOT EXISTS pings (
  steamid TEXT NOT NULL,
  pop TEXT NOT NULL,
  ms INTEGER NOT NULL,
  name TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (steamid, pop)
);

-- indexes: without them every lookup reads whole tables (blew the free daily read limit)
CREATE INDEX IF NOT EXISTS idx_match_stats_player ON match_stats (steamid, map);
CREATE INDEX IF NOT EXISTS idx_match_stats_played ON match_stats (played_at);
CREATE INDEX IF NOT EXISTS idx_flags_status ON flags (status, created_at);
CREATE INDEX IF NOT EXISTS idx_members_status ON members (status);

-- computed results shared by every member's app (squad stats are rebuilt at most every 30 minutes)
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  at INTEGER NOT NULL
);
