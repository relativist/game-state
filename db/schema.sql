-- Serialized by the startup transaction's advisory lock. Never drops existing data.
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  login text NOT NULL UNIQUE CHECK (login = lower(login)),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS player_states (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  zone_id text NOT NULL DEFAULT 'default',
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  score bigint CHECK (score BETWEEN 0 AND 9007199254740991),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id, zone_id)
);
CREATE INDEX IF NOT EXISTS player_states_ranking_idx
  ON player_states(app_id, zone_id, score DESC, user_id ASC) WHERE score IS NOT NULL;
