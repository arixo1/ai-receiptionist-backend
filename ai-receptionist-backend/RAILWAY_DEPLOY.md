# Deploying to Railway

Step-by-step to move this off Replit and onto Railway, where the backend's file-based
config storage actually survives redeploys.

## 1. Get the code onto Railway

Easiest path: push this folder to a GitHub repo, then in Railway click **New Project →
Deploy from GitHub repo** and pick it. (You can also install the Railway CLI and run
`railway init` + `railway up` straight from this folder if you'd rather skip GitHub.)

Railway will detect `package.json` and run `npm install` + `npm start` automatically —
no config file needed for that part.

## 2. Attach a Volume (this is the step that matters)

In the Railway dashboard, open your service → **Settings → Volumes → New Volume**.
Mount it at `/data`. This gives the app a folder that survives restarts and redeploys,
unlike the rest of the container's filesystem.

## 3. Set environment variables

Same service → **Variables** tab. Add:

| Variable | Value |
|---|---|
| `SQUARE_CLIENT_ID` | From your Square Developer app |
| `SQUARE_CLIENT_SECRET` | From your Square Developer app |
| `SQUARE_ENVIRONMENT` | `sandbox` while testing, `production` when live |
| `SQUARE_REDIRECT_URI` | `https://<your-railway-domain>/auth/square/callback` (get the domain from step 4, then come back and set this) |
| `CONFIG_PATH` | `/data/shop-config.json` — inside the Volume from step 2 |

Railway sets `PORT` for you automatically — the code already reads it, nothing to add.

## 4. Get your public domain

Service → **Settings → Networking → Generate Domain**. Railway gives you something like
`your-app-name.up.railway.app`. Copy it — you need it for two places:

- Paste it into `SQUARE_REDIRECT_URI` above (with `/auth/square/callback` on the end)
- Register that *exact same* URL in the Square Developer Console under your app's
  OAuth settings → Redirect URL. These two have to match exactly or Square will reject
  the callback.

## 5. Deploy and test

Push (or `railway up`). On first boot, since the Volume starts empty, the app
automatically copies the bundled `shop-config.json` into it — you'll see a line like
`No config found at /data/shop-config.json — seeded it from the bundled template.`
in the logs.

Then:
1. Visit `https://<your-domain>/onboarding-form.html`
2. Click **Connect Real Square Account**
3. Approve access on Square's real (sandbox) login screen
4. You should land on a "Square connected" confirmation page
5. `POST` to `/api/square/sync` (or wire a button to it later) to pull real items in

## Later: letting me drive this directly

Railway has an official MCP connector — if you connect it (claude.ai connector
settings → search "Railway" → connect, which uses Railway's own login, not a token
pasted into chat), I can create the project, set variables, and deploy from here
directly instead of you clicking through the dashboard.
