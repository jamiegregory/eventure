# Eventure Platform

A modern full-stack platform scaffold using:

- **Frontend:** React 19 + Vite 7 + Tailwind CSS 4
- **Backend:** Node.js 20 + Express 5 + TypeScript
- **Database:** PostgreSQL 16 (via `pg`)
- **API:** REST with validation via Zod

## Architecture

- `apps/frontend` – SPA client, typed API layer, responsive UI.
- `apps/backend` – REST service, DB access layer, input validation.
- `db/init.sql` – schema bootstrap SQL.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure env:

   ```bash
   cp apps/backend/.env.example apps/backend/.env
   cp apps/frontend/.env.example apps/frontend/.env
   ```

3. Start PostgreSQL and run init script:

   ```bash
   psql "$DATABASE_URL" -f db/init.sql
   ```

4. Run app:

   ```bash
   npm run dev
   ```

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173`

## REST endpoints

- `GET /api/health`
- `GET /api/events`
- `POST /api/events`
