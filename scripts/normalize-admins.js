import 'dotenv/config';
import pg from 'pg';

async function run() {
  const emails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (emails.length === 0) {
    console.log('ADMIN_EMAILS not set; no administrator accounts to normalize.');
    return;
  }

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    const result = await client.query(
      `UPDATE users
       SET status = 'active', access_expires_at = NULL, updated_at = NOW()
       WHERE lower(email) = ANY($1::text[])
       RETURNING id, email, status, access_expires_at`,
      [emails]
    );
    console.log(
      `Normalized ${result.rowCount} administrator account(s) to status='active', access_expires_at=NULL.`
    );
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('normalize-admins failed:', err.message);
  process.exit(1);
});