CREATE TABLE IF NOT EXISTS cloud_accounts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_archives (
  user_id TEXT PRIMARY KEY REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  archive_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_documents (
  user_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  total INTEGER NOT NULL,
  ocr INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, material_id, sha256)
);

CREATE TABLE IF NOT EXISTS cloud_document_pages (
  user_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  method TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (user_id, material_id, sha256, page_number)
);

CREATE TABLE IF NOT EXISTS cloud_credentials (
  user_id TEXT PRIMARY KEY REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_sessions_user ON cloud_sessions(user_id);

CREATE TABLE IF NOT EXISTS cloud_auth_attempts (
  scope TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_hash)
);

CREATE TABLE IF NOT EXISTS library_reviewers (
  user_id TEXT PRIMARY KEY REFERENCES cloud_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  goal TEXT NOT NULL,
  subject TEXT NOT NULL,
  year TEXT NOT NULL,
  institution TEXT NOT NULL,
  summary TEXT NOT NULL,
  topics_json TEXT NOT NULL,
  source_note TEXT NOT NULL,
  source_url TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES cloud_accounts(id),
  UNIQUE (owner_user_id, material_id, sha256)
);
CREATE INDEX IF NOT EXISTS library_items_status_subject ON library_items(status, subject, created_at);
CREATE INDEX IF NOT EXISTS library_items_owner ON library_items(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS library_pages (
  item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  method TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (item_id, page_number)
);
