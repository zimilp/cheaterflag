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
