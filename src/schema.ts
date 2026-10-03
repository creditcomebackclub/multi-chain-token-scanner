export const schema = `
CREATE TABLE IF NOT EXISTS setup_candidates (chain text NOT NULL, token text NOT NULL, pool text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(chain,token,pool));
CREATE TABLE IF NOT EXISTS chart_watchlists (day text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS chart_pair_states (chain text NOT NULL, pool text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(chain,pool));
CREATE TABLE IF NOT EXISTS chart_setup_alerts (
  id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL, pool text NOT NULL, data jsonb NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK(status IN ('reserved','sending','sent','unknown','failed')), message_id bigint, sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS chart_setup_alerts_reserved_time ON chart_setup_alerts(reserved_at);
CREATE TABLE IF NOT EXISTS chart_alert_outcomes (
  alert_id text PRIMARY KEY REFERENCES chart_setup_alerts(id), data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS chart_alert_samples (
  alert_id text NOT NULL REFERENCES chart_setup_alerts(id), at timestamptz NOT NULL,
  price double precision NOT NULL, liquidity double precision NOT NULL, PRIMARY KEY(alert_id,at)
);
CREATE TABLE IF NOT EXISTS chart_signals (
  id text PRIMARY KEY, rule text NOT NULL, strategy text NOT NULL, chain text NOT NULL,
  token text NOT NULL, pool text NOT NULL, data jsonb NOT NULL, decision text NOT NULL,
  detected_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS chart_signals_detected_time ON chart_signals(detected_at);
CREATE TABLE IF NOT EXISTS chart_signal_outcomes (
  signal_id text PRIMARY KEY REFERENCES chart_signals(id), data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS chart_signal_samples (
  signal_id text NOT NULL REFERENCES chart_signals(id), at timestamptz NOT NULL,
  price double precision NOT NULL, liquidity double precision NOT NULL, PRIMARY KEY(signal_id,at)
);
CREATE TABLE IF NOT EXISTS chart_candles (
  chain text NOT NULL, token text NOT NULL, pool text NOT NULL, at timestamptz NOT NULL,
  open double precision NOT NULL, high double precision NOT NULL, low double precision NOT NULL,
  close double precision NOT NULL, volume double precision NOT NULL, PRIMARY KEY(chain,pool,at)
);
CREATE INDEX IF NOT EXISTS chart_candles_time ON chart_candles(at);
CREATE TABLE IF NOT EXISTS research_regime_candles (
  asset text NOT NULL CHECK(asset IN ('SOL','ETH','BNB')), chain text NOT NULL,
  token text NOT NULL, pool text NOT NULL, at timestamptz NOT NULL,
  open double precision NOT NULL, high double precision NOT NULL, low double precision NOT NULL,
  close double precision NOT NULL, volume double precision NOT NULL, PRIMARY KEY(asset,at)
);
CREATE INDEX IF NOT EXISTS research_regime_candles_time ON research_regime_candles(at);
CREATE TABLE IF NOT EXISTS young_pool_research_observations (
  id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL, pool text NOT NULL,
  at timestamptz NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(chain,pool)
);
CREATE INDEX IF NOT EXISTS young_pool_research_time ON young_pool_research_observations(at);
CREATE TABLE IF NOT EXISTS young_pool_research_samples (
  observation_id text NOT NULL REFERENCES young_pool_research_observations(id), at timestamptz NOT NULL,
  price double precision NOT NULL, liquidity double precision NOT NULL, PRIMARY KEY(observation_id,at)
);
CREATE TABLE IF NOT EXISTS young_pool_research_outcomes (
  observation_id text PRIMARY KEY REFERENCES young_pool_research_observations(id), data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS wallet_watch_research_observations (
  id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL, source_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL, delay_ms bigint NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS wallet_watch_research_time ON wallet_watch_research_observations(source_at);
CREATE TABLE IF NOT EXISTS wallet_watch_research_samples (
  observation_id text NOT NULL REFERENCES wallet_watch_research_observations(id), at timestamptz NOT NULL,
  price double precision NOT NULL, liquidity double precision NOT NULL, PRIMARY KEY(observation_id,at)
);
CREATE TABLE IF NOT EXISTS wallet_watch_research_outcomes (
  observation_id text PRIMARY KEY REFERENCES wallet_watch_research_observations(id), data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS chart_research_observations (
  id text PRIMARY KEY, rule text NOT NULL, chain text NOT NULL, token text NOT NULL, pool text NOT NULL,
  at timestamptz NOT NULL, kind text NOT NULL CHECK(kind IN ('signal','control')), data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS chart_research_observations_time ON chart_research_observations(at);
CREATE TABLE IF NOT EXISTS chart_research_outcomes (
  observation_id text PRIMARY KEY REFERENCES chart_research_observations(id), data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS chart_positions (
  id text PRIMARY KEY, alert_id text NOT NULL REFERENCES chart_setup_alerts(id), chain text NOT NULL,
  token text NOT NULL, pool text NOT NULL, data jsonb NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(), closed_at timestamptz,
  status text NOT NULL CHECK(status IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS chart_positions_one_open_token ON chart_positions(chain,token) WHERE status='open';
CREATE TABLE IF NOT EXISTS chart_position_events (
  position_id text NOT NULL REFERENCES chart_positions(id), kind text NOT NULL,
  data jsonb NOT NULL, reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK(status IN ('reserved','sent','unknown','failed')),
  message_id bigint, sent_at timestamptz, PRIMARY KEY(position_id,kind)
);

CREATE TABLE IF NOT EXISTS scanner_state (
  id integer PRIMARY KEY CHECK (id = 1), paused boolean NOT NULL DEFAULT false,
  chat_key text, telegram_offset bigint NOT NULL DEFAULT 0
);
INSERT INTO scanner_state(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS rule_versions (id text PRIMARY KEY, config jsonb NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS events (id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL, pool text NOT NULL, at timestamptz NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS events_candidate_time ON events(chain, token, at DESC);
CREATE INDEX IF NOT EXISTS events_time ON events(at);
CREATE TABLE IF NOT EXISTS candidates (chain text NOT NULL, token text NOT NULL, first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL, last_evaluated timestamptz, PRIMARY KEY(chain,token));
CREATE TABLE IF NOT EXISTS discoveries (chain text NOT NULL, token text NOT NULL, tx text NOT NULL, at timestamptz NOT NULL,
  PRIMARY KEY(chain,token,tx));
CREATE TABLE IF NOT EXISTS snapshots (id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL, at timestamptz NOT NULL,
  rule_id text NOT NULL REFERENCES rule_versions(id), score double precision, confirmed boolean NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_candidate_time ON snapshots(chain,token,at DESC);
CREATE TABLE IF NOT EXISTS provider_health (provider text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS coverage_gaps (id bigserial PRIMARY KEY, chain text NOT NULL, since timestamptz NOT NULL, until timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS observation_minutes (rule_id text NOT NULL, scope text NOT NULL, at timestamptz NOT NULL, PRIMARY KEY(rule_id,scope,at));
CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshots(id), reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK(status IN ('reserved','sending','sent','unknown','failed')), message_id bigint, sent_at timestamptz);
CREATE INDEX IF NOT EXISTS alerts_reserved_time ON alerts(reserved_at);
CREATE TABLE IF NOT EXISTS tracked_references (id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshots(id), at timestamptz NOT NULL, kind text NOT NULL CHECK(kind IN ('shadow','alert')));
CREATE INDEX IF NOT EXISTS references_time ON tracked_references(at);
CREATE TABLE IF NOT EXISTS outcome_samples (reference_id text NOT NULL REFERENCES tracked_references(id), at timestamptz NOT NULL,
  price double precision NOT NULL, liquidity double precision NOT NULL, PRIMARY KEY(reference_id,at));
CREATE TABLE IF NOT EXISTS outcomes (reference_id text NOT NULL REFERENCES tracked_references(id), hours integer NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(reference_id,hours));
CREATE TABLE IF NOT EXISTS rollout_approvals (rule_id text NOT NULL, scope text NOT NULL, approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence jsonb NOT NULL, PRIMARY KEY(rule_id,scope));
CREATE TABLE IF NOT EXISTS market_shortlist (
  chain text NOT NULL, token text NOT NULL, pool text NOT NULL, at timestamptz NOT NULL,
  market_pass boolean NOT NULL, priority integer NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(chain,token,pool)
);
CREATE INDEX IF NOT EXISTS market_shortlist_at ON market_shortlist(at);
CREATE TABLE IF NOT EXISTS shortlist_alerts (
  id text PRIMARY KEY, chain text NOT NULL, token text NOT NULL, pool text NOT NULL, data jsonb NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK(status IN ('reserved','sending','sent','unknown','failed')),
  message_id bigint, sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS shortlist_alerts_reserved_time ON shortlist_alerts(reserved_at);
CREATE TABLE IF NOT EXISTS wallet_watch_cursors (
  source text NOT NULL, wallet text NOT NULL, cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(source,wallet)
);
CREATE TABLE IF NOT EXISTS wallet_watch_alerts (
  id text PRIMARY KEY, trader text NOT NULL, wallet text NOT NULL, chain text NOT NULL,
  token text NOT NULL, tx text NOT NULL, side text NOT NULL CHECK(side IN ('buy','sell')),
  data jsonb NOT NULL, reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK(status IN ('reserved','sending','sent','unknown','failed')),
  message_id bigint, sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_watch_alert_identity ON wallet_watch_alerts(trader,chain,tx,token,side);
CREATE INDEX IF NOT EXISTS wallet_watch_alerts_reserved_time ON wallet_watch_alerts(reserved_at);
`;
