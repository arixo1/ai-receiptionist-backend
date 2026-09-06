/**
 * AI Receptionist backend — Square OAuth + Catalog sync + age-gated chat.
 *
 * WHAT THIS DOES
 *   1. GET  /auth/square/connect   — sends the shop owner to Square to log in and approve access.
 *   2. GET  /auth/square/callback  — Square redirects back here with a one-time code; this
 *                                    exchanges it for a real access token and stores it ENCRYPTED.
 *   3. POST /api/square/sync       — pulls real items from Square's Catalog API and writes
 *                                    them into shop-config.json.
 *   4. GET  /api/shop-info         — PUBLIC. Identity + the age-verification prompt only.
 *                                    No products, no POS data — safe for anyone to fetch.
 *   5. POST /api/verify-age        — logs the attempt (pass or fail) to an audit file, and on
 *                                    a pass issues a signed, time-limited token.
 *   6. POST /api/chat              — requires a valid token from step 5 (unless age verification
 *                                    is turned off for this shop). This is now the ONLY way the
 *                                    product catalog reaches a browser — it never ships in a
 *                                    page load or a raw config fetch, so there's nothing for an
 *                                    unverified visitor to read out of dev tools.
 *
 * SETUP ON RAILWAY  (see RAILWAY_DEPLOY.md and AGE-VERIFICATION-SETUP.md for full walkthroughs)
 *   1. railway init in this folder (or connect the Railway dashboard to wherever this lives)
 *   2. Attach a Volume so shop-config.json survives redeploys, and set CONFIG_PATH to a path
 *      inside it (e.g. CONFIG_PATH=/data/shop-config.json) — Railway env var, not this file.
 *      The age-verification audit log lives in the same folder, so it survives redeploys too.
 *   3. Generate an encryption key and an age-token secret (two separate values):
 *        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   4. In Railway's Variables tab, add:
 *        SQUARE_CLIENT_ID       — from your Square Developer app
 *        SQUARE_CLIENT_SECRET   — from your Square Developer app (never put this in a file)
 *        SQUARE_ENVIRONMENT     — "sandbox" while testing, "production" when live
 *        SQUARE_REDIRECT_URI    — https://<your-railway-domain>/auth/square/callback
 *        CONFIG_PATH            — /data/shop-config.json (matching the Volume mount path)
 *        ENCRYPTION_KEY         — 64-character hex string (generated above)
 *        AGE_TOKEN_SECRET       — a separate random string (generated above) — falls back to
 *                                 reusing ENCRYPTION_KEY if omitted, but a dedicated value is better
 *        AGE_TOKEN_TTL_MINUTES  — optional, how long a verification lasts (default: 120)
 *   5. railway up (or push — Railway redeploys automatically on connected repos)
 *
 * TESTING WITHOUT REAL CREDENTIALS
 *   SQUARE_OAUTH_BASE_OVERRIDE and SQUARE_API_BASE_OVERRIDE let you point this whole flow at
 *   a fake local Square for testing. Leave them unset for real use.
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto-utils');
const { signToken, verifyToken, logVerificationAttempt } = require('./age-verification');
const { generateChatResponse } = require('./chat-engine');

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
// The Railway proxy sits in front of this app — trust its X-Forwarded-For header
// so req.ip reflects the visitor's real address instead of Railway's internal IP.
// This matters for the age-verification audit log below.
app.set('trust proxy', true);

// PUBLIC, INTENTIONALLY MINIMAL. Used by the onboarding form to show connection
// status. Used to also serve the full config (including products and, briefly,
// decrypted tokens) to any visitor — that's now gone. Product data only ever
// reaches a browser through POST /api/chat, after age verification.
app.get('/shop-config.json', (req, res) => {
  const config = readConfig();
  const pos = config.pos_connection || {};
  res.json({
    pos_connection: {
      provider: pos.provider || null,
      connected: !!pos.connected,
      last_synced: pos.last_synced || null
    }
  });
});

app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// PUBLIC. Identity + the age-verification prompt text — nothing a shop would
// consider sensitive, and nothing that requires being 21+ to see (a shop's
// name, hours, and "are you 21?" question aren't gated content anywhere).
// ---------------------------------------------------------------------------
app.get('/api/shop-info', (req, res) => {
  const config = readConfig();
  res.json({
    identity: config.identity,
    compliance: {
      require_age_verification: !!config.compliance.require_age_verification,
      verification_prompt: config.compliance.verification_prompt,
      verification_fail_message: config.compliance.verification_fail_message,
      min_age: config.compliance.min_age
    },
    quick_questions: config.quick_questions || []
  });
});

// ---------------------------------------------------------------------------
// Every verification attempt is logged — pass or fail — with a timestamp and
// the visitor's IP, before anything else happens. A "yes" issues a signed
// token; a "no" gets the shop's configured decline message and nothing else.
// ---------------------------------------------------------------------------
app.post('/api/verify-age', (req, res) => {
  const config = readConfig();
  const confirmed = req.body && req.body.confirmed === true;

  logVerificationAttempt(CONFIG_PATH, {
    timestamp: new Date().toISOString(),
    shop_id: config.shop_id,
    ip: req.ip,
    user_agent: req.headers['user-agent'] || 'unknown',
    result: confirmed ? 'confirmed' : 'denied'
  });

  if (!confirmed) {
    return res.json({
      verified: false,
      message: config.compliance.verification_fail_message
    });
  }

  const ttlMinutes = parseInt(process.env.AGE_TOKEN_TTL_MINUTES, 10) || 120;
  const token = signToken({
    verified: true,
    shop_id: config.shop_id,
    exp: Date.now() + ttlMinutes * 60 * 1000
  });

  res.json({ verified: true, token });
});

// ---------------------------------------------------------------------------
// The ONLY route that returns product/pricing data. Requires a valid token
// from /api/verify-age above whenever the shop has age verification turned
// on — there is no other path to this data from the browser.
// ---------------------------------------------------------------------------
app.post('/api/chat', (req, res) => {
  const config = readConfig();
  const { message, token } = req.body || {};

  if (config.compliance.require_age_verification) {
    const payload = verifyToken(token);
    if (!payload || !payload.verified || payload.shop_id !== config.shop_id) {
      return res.status(403).json({ error: 'age_verification_required' });
    }
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const response = generateChatResponse(message, config);
  res.json({ response });
});

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
      // ENCRYPT before storing
      access_token_encrypted: encrypt(tokenData.access_token),
      refresh_token_encrypted: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
      expires_at: tokenData.expires_at || null,
      last_synced: null,
      // Keep whatever sample items were there until the first real /api/square/sync call.
      mock_catalog: (config.pos_connection && config.pos_connection.mock_catalog) || []
    };
    writeConfig(config);

    res.send(`
      <body style="font-family:sans-serif;background:#0a0a0a;color:#fff;padding:3rem;text-align:center;">
        <h2>✅ Square connected & tokens encrypted</h2>
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
  
  if (!pos || !pos.connected) {
    return res.status(400).json({ error: 'Square is not connected for this shop yet.' });
  }

  // DECRYPT before using
  const accessToken = decrypt(pos.access_token_encrypted);
  if (!accessToken) {
    return res.status(400).json({ error: 'Could not decrypt Square access token. Token may be corrupted or key changed.' });
  }

  try {
    // Fetched up front so every item below can be tagged with its category name
    // in one pass, instead of looking it up per item.
    const categoryMap = await fetchCategoryMap(accessToken);

    const resp = await fetch(`${SQUARE_API_BASE}/v2/catalog/search-catalog-items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
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
  console.log(`Config path: ${CONFIG_PATH}`);
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('⚠️  ENCRYPTION_KEY not set — using development default (not secure for production)');
  }
  if (!process.env.AGE_TOKEN_SECRET) {
    console.warn('⚠️  AGE_TOKEN_SECRET not set — falling back to ENCRYPTION_KEY (or an insecure default if that\'s missing too)');
  }
});
