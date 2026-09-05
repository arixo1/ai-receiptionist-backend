/**
 * AI Receptionist backend — Square OAuth + Catalog sync.
 *
 * WHAT THIS DOES
 *   1. GET  /auth/square/connect   — sends the shop owner to Square to log in and approve access.
 *   2. GET  /auth/square/callback  — Square redirects back here with a one-time code; this
 *                                    exchanges it for a real access token and stores it.
 *   3. POST /api/square/sync       — pulls real items from Square's Catalog API and writes
 *                                    them into shop-config.json, where the chatbot engine
 *                                    already knows how to read them (same field it used for
 *                                    the sample/mock data — this just fills it with real items).
 *
 * SETUP ON RAILWAY  (see RAILWAY_DEPLOY.md for the full click-by-click version)
 *   1. railway init in this folder (or connect the Railway dashboard to wherever this lives)
 *   2. Attach a Volume so shop-config.json survives redeploys, and set CONFIG_PATH to a path
 *      inside it (e.g. CONFIG_PATH=/data/shop-config.json) — Railway env var, not this file.
 *   3. In Railway's Variables tab (not a file — this is their equivalent of Replit Secrets), add:
 *        SQUARE_CLIENT_ID       — from your Square Developer app
 *        SQUARE_CLIENT_SECRET   — from your Square Developer app (never put this in a file)
 *        SQUARE_ENVIRONMENT     — "sandbox" while testing, "production" when live
 *        SQUARE_REDIRECT_URI    — https://<your-railway-domain>/auth/square/callback
 *                                  (must exactly match what you register in the Square
 *                                  Developer Console's OAuth settings)
 *        CONFIG_PATH            — /data/shop-config.json (matching the Volume mount path)
 *   4. railway up (or push — Railway redeploys automatically on connected repos)
 *   5. Open the Railway-issued URL, go to onboarding-form.html, click "Connect Real Square Account".
 *
 * TESTING WITHOUT REAL CREDENTIALS
 *   SQUARE_OAUTH_BASE_OVERRIDE and SQUARE_API_BASE_OVERRIDE let you point this whole flow at
 *   a fake local Square for testing (see how this was verified before delivery). Leave them
 *   unset for real use — they default to Square's real sandbox/production URLs.
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_CONFIG_TEMPLATE = path.join(__dirname, 'shop-config.json');
const CONFIG_PATH = process.env.CONFIG_PATH || DEFAULT_CONFIG_TEMPLATE;

// A Railway Volume starts out empty — if CONFIG_PATH points somewhere other than the
// bundled default (i.e. we're pointed at a mounted volume) and nothing's there yet,
// seed it from the template that ships with the code so the app has something to serve
// on first boot instead of crashing.
if (CONFIG_PATH !== DEFAULT_CONFIG_TEMPLATE && !fs.existsSync(CONFIG_PATH)) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.copyFileSync(DEFAULT_CONFIG_TEMPLATE, CONFIG_PATH);
  console.log(`No config found at ${CONFIG_PATH} — seeded it from the bundled template.`);
}

const SQUARE_ENV = process.env.SQUARE_ENVIRONMENT || 'sandbox';
const DEFAULT_BASE = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';
const SQUARE_OAUTH_BASE = process.env.SQUARE_OAUTH_BASE_OVERRIDE || DEFAULT_BASE;
const SQUARE_API_BASE = process.env.SQUARE_API_BASE_OVERRIDE || DEFAULT_BASE;
const SQUARE_VERSION = '2026-08-19';

const CLIENT_ID = process.env.SQUARE_CLIENT_ID;
const CLIENT_SECRET = process.env.SQUARE_CLIENT_SECRET;
const REDIRECT_URI = process.env.SQUARE_REDIRECT_URI;

// Short-lived in-memory CSRF state store. Fine for a single-instance scaffold;
// resets on restart, which just means an in-flight connect attempt has to be redone.
const pendingStates = new Map();

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Square categories are a separate object type from items, so a second call is
// needed to turn the category IDs on each item into human-readable names. If this
// fails for any reason, we fall back to grouping everything as "Uncategorized"
// rather than failing the whole sync over it.
async function fetchCategoryMap(accessToken) {
  const map = {};
  try {
    const resp = await fetch(`${SQUARE_API_BASE}/v2/catalog/list?types=CATEGORY`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION
      }
    });
    const data = await resp.json();
    (data.objects || []).forEach(obj => {
      if (obj.type === 'CATEGORY' && obj.category_data) {
        map[obj.id] = obj.category_data.name;
      }
    });
  } catch (err) {
    console.error('Could not fetch Square categories (continuing without them):', err);
  }
  return map;
}

// Square has shipped a couple of different shapes for "which category is this
// item in" over time – reporting_category (newest), categories[] (current),
// and category_id (legacy, singular). Check them in that order.
function categoryNameForItem(itemData, categoryMap) {
  const categoryId =
    (itemData.reporting_category && itemData.reporting_category.id) ||
    (itemData.categories && itemData.categories[0] && itemData.categories[0].id) ||
    itemData.category_id ||
    null;
  return (categoryId && categoryMap[categoryId]) || 'Uncategorized';
}

app.use(express.json());

// Serve the LIVE config — which may live on a mounted Railway Volume at CONFIG_PATH —
// instead of falling through to the static copy bundled with the code. Must be
// registered before express.static, or express.static would win and always hand out
// the unchanging bundled file instead of the one OAuth/sync actually update.
app.get('/shop-config.json', (req, res) => {
  res.type('application/json').send(fs.readFileSync(CONFIG_PATH, 'utf8'));
});

app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Step 1: shop owner clicks "Connect Square" -> here -> redirected to Square
// ---------------------------------------------------------------------------
app.get('/auth/square/connect', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).send(
      'SQUARE_CLIENT_ID is not set. Add your Square app credentials in Replit Secrets first.'
    );
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'MERCHANT_PROFILE_READ ITEMS_READ',
    session: 'false',
    state
  });
  res.redirect(`${SQUARE_OAUTH_BASE}/oauth2/authorize?${params.toString()}`);
});

// ---------------------------------------------------------------------------
// Step 2: Square redirects back here with a one-time code
// ---------------------------------------------------------------------------
app.get('/auth/square/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Square returned an error: ${error}`);
  }
  if (!code || !state || !pendingStates.has(state)) {
    return res.status(400).send(
      'Missing or invalid state — this request did not start from our own "Connect Square" link.'
    );
  }
  pendingStates.delete(state);

  try {
    // The one piece that truly cannot happen in browser JS: trading the code
    // for a token requires the client secret.
    const tokenResp = await fetch(`${SQUARE_OAUTH_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error('Square token exchange failed:', tokenData);
      return res.status(502).send(`Square token exchange failed: ${JSON.stringify(tokenData.errors || tokenData)}`);
    }

    // Find which location this token covers, so the bot knows what to sync.
    const locResp = await fetch(`${SQUARE_API_BASE}/v2/locations`, {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Square-Version': SQUARE_VERSION }
    });
    const locData = await locResp.json();
    const firstLocation = (locData.locations && locData.locations[0]) || {};

    const config = readConfig();
    config.pos_connection = {
      provider: 'square',
      connected: true,
      location_id: firstLocation.id || null,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: tokenData.expires_at || null,
      last_synced: null,
      // Keep whatever sample items were there until the first real /api/square/sync call.
      mock_catalog: (config.pos_connection && config.pos_connection.mock_catalog) || []
    };
    writeConfig(config);

    res.send(`
      <body style="font-family:sans-serif;background:#0a0a0a;color:#fff;padding:3rem;text-align:center;">
        <h2>Square connected</h2>
        <p>Location: ${firstLocation.name || firstLocation.id || 'unknown'}</p>
        <p>Next: call POST /api/square/sync (or hit "Sync inventory" in the onboarding form) to pull real items.</p>
      </body>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong exchanging the token — check server logs.');
  }
});

// ---------------------------------------------------------------------------
// Step 3: pull real items from Square's Catalog API into the shop's config
// ---------------------------------------------------------------------------
app.post('/api/square/sync', async (req, res) => {
  const config = readConfig();
  const pos = config.pos_connection;
  if (!pos || !pos.connected || !pos.access_token) {
    return res.status(400).json({ error: 'Square is not connected for this shop yet.' });
  }

  try {
    // Fetched up front so every item below can be tagged with its category name
    // in one pass, instead of looking it up per item.
    const categoryMap = await fetchCategoryMap(pos.access_token);

    const resp = await fetch(`${SQUARE_API_BASE}/v2/catalog/search-catalog-items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pos.access_token}`,
        'Content-Type': 'application/json',
        'Square-Version': SQUARE_VERSION
      },
      body: JSON.stringify({ limit: 100 })
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(502).json({ error: 'Square catalog request failed', details: data.errors || data });
    }

    // Same flat list as before (mock_catalog) for anything that still reads it,
    // plus a by-category breakdown (mock_catalog_by_category) so the chatbot can
    // answer category-specific questions ("do you have vapes?") instead of only
    // ever showing everything synced from Square at once.
    const flatItems = [];
    const itemsByCategory = {};

    (data.items || []).forEach(item => {
      const itemData = item.item_data || {};
      const variations = itemData.variations || [];
      if (variations.length === 0) return;

      const categoryName = categoryNameForItem(itemData, categoryMap);

      variations.forEach(v => {
        const vd = v.item_variation_data || {};
        const amount = vd.price_money ? (vd.price_money.amount / 100).toFixed(2) : null;
        const entry = {
          name: variations.length > 1 ? `${itemData.name} - ${vd.name}` : itemData.name,
          price: amount ? `$${amount}` : 'Call for price',
          details: 'Synced from Square'
        };
        flatItems.push(entry);
        (itemsByCategory[categoryName] = itemsByCategory[categoryName] || []).push(entry);
      });
    });

    config.pos_connection.mock_catalog = flatItems;
    config.pos_connection.mock_catalog_by_category = itemsByCategory;
    config.pos_connection.last_synced = new Date().toISOString();
    writeConfig(config);

    res.json({ synced: flatItems.length, categories: Object.keys(itemsByCategory), items: flatItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sync failed — check server logs.' });
  }
});

app.listen(PORT, () => {
  console.log(`Receptionist backend running on port ${PORT}`);
  console.log(`Square environment: ${SQUARE_ENV} (${SQUARE_OAUTH_BASE})`);
});
