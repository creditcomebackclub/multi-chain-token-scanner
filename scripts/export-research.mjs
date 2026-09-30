import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const chartAlerts = (await db.query(`
    SELECT sent_at,data FROM chart_setup_alerts
    WHERE status='sent' ORDER BY sent_at DESC LIMIT 50
  `)).rows;
  const shortlistAlerts = (await db.query(`
    SELECT sent_at,data FROM shortlist_alerts
    WHERE status='sent' ORDER BY sent_at DESC LIMIT 50
  `)).rows;
  const watchlists = (await db.query(`
    SELECT day,data FROM chart_watchlists ORDER BY day DESC LIMIT 7
  `)).rows;
  const chartStates = (await db.query(`
    SELECT chain,pool,data FROM chart_pair_states
    WHERE (data->>'checkedAt')::double precision > extract(epoch FROM now()-interval '24 hours')*1000
  `)).rows;
  console.log(JSON.stringify({ fetchedAt: new Date().toISOString(), chartAlerts, shortlistAlerts, watchlists, chartStates }));
} finally {
  await db.end();
}
