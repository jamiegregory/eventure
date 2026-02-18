import { Pool } from 'pg';
import { config } from './config.js';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

export type EventRecord = {
  id: number;
  title: string;
  description: string;
  starts_at: string;
  created_at: string;
};

export async function listEvents(): Promise<EventRecord[]> {
  const result = await pool.query<EventRecord>(
    'SELECT id, title, description, starts_at, created_at FROM events ORDER BY starts_at ASC',
  );
  return result.rows;
}

export async function createEvent(input: {
  title: string;
  description: string;
  startsAt: string;
}): Promise<EventRecord> {
  const result = await pool.query<EventRecord>(
    `
      INSERT INTO events (title, description, starts_at)
      VALUES ($1, $2, $3)
      RETURNING id, title, description, starts_at, created_at
    `,
    [input.title, input.description, input.startsAt],
  );

  return result.rows[0];
}
