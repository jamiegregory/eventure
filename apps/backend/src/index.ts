import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { createEvent, listEvents } from './db.js';

const app = express();

app.use(
  cors({
    origin: config.FRONTEND_URL,
  }),
);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/events', async (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const events = await listEvents();
    res.json({ data: events });
  } catch (error) {
    next(error);
  }
});

const createEventSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(1000),
  startsAt: z.string().datetime(),
});

app.post('/api/events', async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const parsed = createEventSchema.parse(req.body);
    const event = await createEvent(parsed);
    res.status(201).json({ data: event });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Invalid request payload',
      details: error.flatten(),
    });
  }

  console.error(error);
  return res.status(500).json({
    error: 'Internal server error',
  });
});

app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
});
