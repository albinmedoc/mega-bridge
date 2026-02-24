-- Initial schema: folders and files tables

CREATE TABLE IF NOT EXISTS folders (
  folder_id TEXT PRIMARY KEY,
  folder_key TEXT NOT NULL,
  name TEXT,
  loaded_at TEXT NOT NULL,
  downloading INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  rate_limited_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  node_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  timestamp INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (folder_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_folder_status ON files(folder_id, status);
