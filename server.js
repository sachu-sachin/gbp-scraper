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

    // ── Navigate to the Updates / Posts tab ──────────────────────────────────
    let postsFound = false;

    // Try clicking the "Updates" tab
    const tabSelectors = [
      'button[aria-label="Updates"]',
      'button[data-tab-index]',
      '[role="tab"]',
    ];

    for (const sel of tabSelectors) {
      try {
        const tabs = await page.$$(sel);
        for (const tab of tabs) {
          const label = await page.evaluate(el => el.innerText || el.getAttribute('aria-label') || '', tab);
          if (/updates|posts|what.s new/i.test(label)) {
            await tab.click();
            await sleep(2000);
            postsFound = true;
            break;
          }
        }
        if (postsFound) break;
      } catch (_) {}
    }

    // ── Scroll to load more posts ─────────────────────────────────────────────
    await autoScroll(page, 3);

    // ── Extract posts ────────────────────────────────────────────────────────
    const posts = await page.evaluate((max) => {
      const results = [];

      // Selectors for GBP posts (Google updates these periodically)
      const postContainerSelectors = [
        '[data-attrid="kc:/local/place:local_update"]',
        '.m6QErb .WNFist',
        '.m6QErb [data-update-id]',
        'div[jsaction*="update"] .Io6YTe',
        '.K7oBsc',
        '.Yr7JEd',
        '.kA9KIf',
        '[data-local-update-key]',
      ];

      let postEls = [];
      for (const sel of postContainerSelectors) {
        postEls = Array.from(document.querySelectorAll(sel));
        if (postEls.length > 0) break;
      }

      // Fallback: look for post-like blocks with text content
      if (postEls.length === 0) {
        const allDivs = Array.from(document.querySelectorAll('div[role="article"], .iA8QLe, .Io6YTe'));
        postEls = allDivs.filter(d => d.innerText && d.innerText.length > 30);
      }

      for (const el of postEls.slice(0, max)) {
        const text = el.innerText || '';
        if (!text.trim()) continue;

        // Detect post type
        let postType = "What's New";
        const lower = text.toLowerCase();
        if (/offer|discount|sale|% off|coupon|deal/i.test(lower)) postType = 'Offer';
        else if (/event|workshop|webinar|seminar|bootcamp|class|batch/i.test(lower)) postType = 'Event';

        // Extract date
        let dateStr = '';
        const dateEl = el.querySelector('[aria-label*="ago"], .LrzXr, [data-value], time');
        if (dateEl) {
          dateStr = dateEl.getAttribute('aria-label') || dateEl.getAttribute('data-value') || dateEl.innerText || '';
        }
        if (!dateStr) {
          const dateMatch = text.match(/\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{0,4}|\d{4}-\d{2}-\d{2}|\d+\s+(?:hour|day|week|month)s?\s+ago)\b/i);
          if (dateMatch) dateStr = dateMatch[1];
        }

        // Clean content
        const content = text
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !/^(Like|Share|More|Report)$/i.test(l))
          .join(' ')
          .substring(0, 500);

        if (content.length > 10) {
          results.push({ type: postType, date: dateStr || 'recent', content });
        }
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

// ── Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), port: PORT });
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
