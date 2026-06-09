# FILO

AI-powered landscape design CRM — [getfilocrm.com](https://getfilocrm.com)

This is the consolidated FILO monorepo. The former `filo-app` and
`filo-backend` repositories now live side by side here, with both
commit histories preserved.

## Layout

| Directory | What it is | Deployed on |
|-----------|------------|-------------|
| `app/`    | React + Vite frontend (SPA) | Vercel — project **Root Directory** must be set to `app` |
| `server/` | Express API server | Railway — service **Root Directory** must be set to `server` (builds `server/Dockerfile`) |

The two packages are independent — each has its own `package.json`,
lockfile, and `npm install`. There is no root workspace.

## Development

Frontend (Vite dev server on port 3000):

```sh
cd app
npm install
npm run dev
```

Backend (Express on port 4000 by default):

```sh
cd server
npm install
npm run dev
```

Frontend tests:

```sh
cd app
npm test
```

## Environment variables

- Frontend: copy `app/.env.example` to `app/.env` and fill in values.
  In production these are set in Vercel → Settings → Environment Variables.
- Backend: configured entirely through Railway service variables
  (`PORT`, database, Stripe, AI provider keys, etc.).
