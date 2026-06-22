/**
 * Yale IT Skill Hub – GBP Competitor Scraper Server
 * ===================================================
 * Express + Puppeteer server that scrapes Google Business Profile
 * pages and returns the last N posts as structured JSON.
 *
 * POST /scrape        → scrape one GBP URL
 * POST /scrape-batch  → scrape multiple GBP URLs in sequence
 * GET  /health        → health check
 *
 * Usage: node server.js
 * Default port: 3000  (override with PORT env var)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const puppeteerCore = require('puppeteer-core');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const API_KEY       = process.env.API_KEY       || null;   // if set, required on /scrape* requests
const CHROME_PATH   = process.env.CHROME_PATH   || findChrome();
const MAX_POSTS     = process.env.MAX_POSTS      ? parseInt(process.env.MAX_POSTS) : 10;
const TIMEOUT_MS    = process.env.TIMEOUT_MS     ? parseInt(process.env.TIMEOUT_MS) : 45000;
const DELAY_BETWEEN = process.env.DELAY_BETWEEN  ? parseInt(process.env.DELAY_BETWEEN) : 2000;

// Attempt to auto-detect Chrome/Chromium on common paths
function findChrome() {
  const { execSync } = require('child_process');
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try {
      const fs = require('fs');
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  // Try `which` on Linux/Mac
  try { return execSync('which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null').toString().trim(); }
  catch (_) { return null; }
}

// ─── LAUNCH BROWSER ──────────────────────────────────────────────────────────
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1280,900',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--lang=en-US,en',
    ],
    defaultViewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  };
  if (CHROME_PATH) {
    launchOptions.executablePath = CHROME_PATH;
  } else if (process.env.NODE_ENV === 'production') {
    // On Render or production, use Puppeteer's bundled Chromium
    launchOptions.executablePath = (await puppeteerCore.executablePath());
  }
  browser = await puppeteerCore.launch(launchOptions);
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// ─── SLEEP HELPER ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── CORE SCRAPER ────────────────────────────────────────────────────────────
/**
 * Scrape a single GBP URL and return structured post data.
 * @param {string} gbpUrl   - Google Maps / GBP URL of the competitor
 * @param {number} maxPosts - Max number of posts to return
 * @returns {object}
 */
async function scrapeGBPPosts(gbpUrl, maxPosts = MAX_POSTS) {
  const br = await getBrowser();
  const page = await br.newPage();

  try {
    // Spoof user-agent to avoid bot detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36'
    );

    // Block images, fonts, and tracking to speed things up
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ── Navigate to GBP page ─────────────────────────────────────────────────
    console.log(`[Scraper] Navigating to: ${gbpUrl}`);
    await page.goto(gbpUrl, { waitUntil: 'networkidle2', timeout: TIMEOUT_MS });

    // Dismiss consent / cookie banners if present
    try {
      const consentBtn = await page.$('button[aria-label*="Accept"], button[aria-label*="Agree"]');
      if (consentBtn) { await consentBtn.click(); await sleep(1000); }
    } catch (_) {}

    // ── Wait for business panel to load ─────────────────────────────────────
    await page.waitForSelector('div[data-attrid="title"], h1.DUwDvf, [data-feature-id="mapcard-v2"]', {
      timeout: TIMEOUT_MS
    }).catch(() => {});

    await sleep(2000);

    // ── Extract business name ────────────────────────────────────────────────
    const businessName = await page.evaluate(() => {
      const selectors = ['h1.DUwDvf', 'h1[data-attrid="title"]', 'h1', '.lMbq3e h1'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim()) return el.innerText.trim();
      }
      return document.title.replace(' - Google Maps', '').trim();
    });

    // ── Open the posts feed ──────────────────────────────────────────────────
    // Google Maps exposes a business's posts via a "See local posts" /
    // "Latest updates" affordance (NOT a normal tab). Find and click it.
    let postsOpened = false;
    try {
      const handle = await page.evaluateHandle(() => {
        const els = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        return els.find(e => /see local posts|latest updates|from the owner|updates/i
          .test(((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')))) || null;
      });
      const el = handle.asElement();
      if (el) { await el.click(); postsOpened = true; await sleep(3000); }
      await handle.dispose();
    } catch (_) {}

    // ── Scroll the feed to load more posts ────────────────────────────────────
    await autoScroll(page, 4);

    // ── Extract posts ────────────────────────────────────────────────────────
    const posts = await page.evaluate((max) => {
      const results = [];

      // Primary: post cards in the Maps "local posts" feed.
      // (Google renames these classes periodically — update if extraction breaks.)
      let postEls = Array.from(document.querySelectorAll('.cKbrCd'));
      if (postEls.length === 0) {
        for (const sel of ['[data-update-id]', '[data-local-update-key]', '.Rfb4Xc']) {
          postEls = Array.from(document.querySelectorAll(sel));
          if (postEls.length) break;
        }
      }

      const seen = new Set();
      for (const el of postEls) {
        if (results.length >= max) break;
        const full = (el.innerText || '').replace(/ /g, ' ').trim();
        if (!full) continue;

        // Post body lives in .Rfb4Xc; otherwise use the whole card text
        const bodyEl = el.querySelector('.Rfb4Xc');
        let content = (bodyEl ? bodyEl.innerText : full).replace(/\s+/g, ' ').trim();

        // Date: "Jun 15, 2026" | "3 days ago" | "Today"/"Yesterday"
        let dateStr = '';
        const m = full.match(/\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/)
               || full.match(/\b(\d+\s+(?:hour|day|week|month|year)s?\s+ago)\b/i)
               || full.match(/\b(Today|Yesterday)\b/);
        if (m) dateStr = m[1];

        // Strip a leading date token if it bled into the body
        if (dateStr) content = content.replace(dateStr, '').trim();
        content = content.replace(/^[\s•\-]+/, '').trim();

        if (content.length < 8) continue;          // skip empties / UI noise
        if (seen.has(content)) continue;            // de-dupe
        seen.add(content);

        let type = "What's New";
        if (/offer|discount|sale|%\s*off|coupon|deal/i.test(content)) type = 'Offer';
        else if (/event|workshop|webinar|seminar|bootcamp|class|batch|outing/i.test(content)) type = 'Event';

        results.push({ type, date: dateStr || 'recent', content: content.slice(0, 800) });
      }

      return results;
    }, maxPosts);

    console.log(`[Scraper] Found ${posts.length} posts for: ${businessName}`);

    return {
      success: true,
      competitorName: businessName,
      gbpUrl,
      scrapedAt: new Date().toISOString(),
      postsCount: posts.length,
      posts,
    };

  } catch (err) {
    console.error(`[Scraper] Error scraping ${gbpUrl}:`, err.message);
    return {
      success: false,
      competitorName: 'Unknown',
      gbpUrl,
      scrapedAt: new Date().toISOString(),
      error: err.message,
      posts: [],
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── AUTO-SCROLL ──────────────────────────────────────────────────────────────
async function autoScroll(page, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => {
      const scrollable = document.querySelector('div[role="main"]') || window;
      scrollable.scrollBy(0, 800);
    });
    await sleep(1200);
  }
}

// ─── EXPRESS SERVER ───────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Health check (always open, no auth — used by monitoring/uptime checks)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), port: PORT });
});

// ── API token auth (applies to all routes below this point)
// If API_KEY is set, every request must send the matching token via either:
//   x-api-key: <token>            OR            Authorization: Bearer <token>
app.use((req, res, next) => {
  if (!API_KEY) return next(); // auth disabled when no key configured
  const headerKey = req.get('x-api-key');
  const auth      = req.get('authorization') || '';
  const bearer    = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (headerKey === API_KEY || bearer === API_KEY) return next();
  console.warn(`[Auth] Rejected ${req.method} ${req.path} from ${req.ip} — bad/missing API key`);
  return res.status(401).json({ success: false, error: 'Unauthorized: missing or invalid API key' });
});

// ── Scrape single GBP URL
// Body: { url: string, maxPosts?: number }
app.post('/scrape', async (req, res) => {
  const { url, maxPosts } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Missing required field: url' });
  }

  try {
    const result = await scrapeGBPPosts(url, maxPosts || MAX_POSTS);
    res.json(result);
  } catch (err) {
    console.error('[/scrape] Unhandled error:', err.message);
    res.status(500).json({ success: false, error: err.message, posts: [] });
  }
});

// ── Scrape multiple GBP URLs in sequence
// Body: { competitors: [{ name: string, url: string }], maxPosts?: number }
app.post('/scrape-batch', async (req, res) => {
  const { competitors, maxPosts } = req.body;

  if (!competitors || !Array.isArray(competitors) || competitors.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing required field: competitors (array)' });
  }

  const results = [];

  for (const comp of competitors) {
    if (!comp.url) {
      results.push({ success: false, competitorName: comp.name || 'Unknown', error: 'No URL provided', posts: [] });
      continue;
    }

    console.log(`[Batch] Scraping ${comp.name || comp.url} ...`);
    const result = await scrapeGBPPosts(comp.url, maxPosts || MAX_POSTS);
    // Override name from input if scraper couldn't detect it
    if (comp.name && result.competitorName === 'Unknown') result.competitorName = comp.name;
    results.push(result);

    // Polite delay between requests
    if (competitors.indexOf(comp) < competitors.length - 1) {
      await sleep(DELAY_BETWEEN);
    }
  }

  res.json({
    success: true,
    total: results.length,
    scrapedAt: new Date().toISOString(),
    results,
  });
});

// ── 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found. Use POST /scrape or POST /scrape-batch' });
});

// ── Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   Yale IT Skill Hub – GBP Competitor Scraper         ║');
  console.log(`║   Running on http://localhost:${PORT}                   ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  POST http://localhost:${PORT}/scrape        → single URL`);
  console.log(`  POST http://localhost:${PORT}/scrape-batch  → multiple URLs`);
  console.log('');

  console.log(API_KEY
    ? '[Auth] API key required on /scrape and /scrape-batch (x-api-key header).'
    : '[Auth] WARNING: no API_KEY set — endpoints are OPEN to anyone who can reach the port.');

  if (!CHROME_PATH) {
    console.warn('[WARNING] Chrome/Chromium not found automatically.');
    console.warn('  Set CHROME_PATH env var to your Chrome executable path.');
    console.warn('  e.g. CHROME_PATH=/usr/bin/google-chrome node server.js');
  } else {
    console.log(`[Browser] Using Chrome at: ${CHROME_PATH}`);
  }

  // Pre-warm browser
  try {
    await getBrowser();
    console.log('[Browser] Puppeteer browser launched successfully.');
  } catch (err) {
    console.error('[Browser] Failed to launch browser:', err.message);
    console.error('  Make sure Chrome/Chromium is installed.');
  }

  console.log('');
  console.log('[Server] Ready to accept requests from n8n.');
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
