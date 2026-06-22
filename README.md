# Yale IT Skill Hub – GBP Competitor Scraper

Puppeteer-based Express server that scrapes Google Business Profile pages and returns competitor post data as JSON for your n8n workflow.

---

## Requirements

- **Node.js** v18 or higher
- **Google Chrome** or **Chromium** installed on the machine

---

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Start the server
node server.js
```

The server starts on **http://localhost:3000** by default.

---

## Environment Variables

| Variable       | Default            | Description                                  |
|----------------|--------------------|----------------------------------------------|
| `PORT`         | `3000`             | Server port                                  |
| `CHROME_PATH`  | auto-detected      | Full path to Chrome/Chromium executable      |
| `MAX_POSTS`    | `10`               | Default max posts per competitor             |
| `TIMEOUT_MS`   | `45000`            | Page load timeout in milliseconds            |
| `DELAY_BETWEEN`| `2000`             | Delay between batch requests (ms)            |

### Setting Chrome Path (if auto-detect fails)

**Linux:**
```bash
CHROME_PATH=/usr/bin/google-chrome node server.js
```

**macOS:**
```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node server.js
```

**Windows:**
```cmd
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
node server.js
```

---

## API Endpoints

### GET /health
Health check.

**Response:**
```json
{ "status": "ok", "timestamp": "2026-06-22T08:00:00.000Z", "port": 3000 }
```

---

### POST /scrape
Scrape one competitor GBP URL.

**Request Body:**
```json
{
  "url": "https://maps.google.com/?cid=1234567890",
  "maxPosts": 10
}
```

**Response:**
```json
{
  "success": true,
  "competitorName": "Competitor Name",
  "gbpUrl": "https://maps.google.com/?cid=1234567890",
  "scrapedAt": "2026-06-22T08:00:00.000Z",
  "postsCount": 5,
  "posts": [
    {
      "type": "What's New",
      "date": "3 days ago",
      "content": "Join our Python bootcamp this weekend! Limited seats..."
    },
    {
      "type": "Offer",
      "date": "1 week ago",
      "content": "50% off on our Web Development course this month only..."
    }
  ]
}
```

---

### POST /scrape-batch
Scrape multiple competitor GBP URLs sequentially.

**Request Body:**
```json
{
  "competitors": [
    { "name": "Competitor A", "url": "https://maps.google.com/?cid=111" },
    { "name": "Competitor B", "url": "https://maps.google.com/?cid=222" }
  ],
  "maxPosts": 10
}
```

**Response:**
```json
{
  "success": true,
  "total": 2,
  "scrapedAt": "2026-06-22T08:00:00.000Z",
  "results": [
    {
      "success": true,
      "competitorName": "Competitor A",
      "gbpUrl": "https://maps.google.com/?cid=111",
      "postsCount": 8,
      "posts": [...]
    },
    {
      "success": true,
      "competitorName": "Competitor B",
      "gbpUrl": "https://maps.google.com/?cid=222",
      "postsCount": 5,
      "posts": [...]
    }
  ]
}
```

---

## How to Get a Competitor's GBP URL

1. Search for the competitor on Google Maps
2. Click on their business listing
3. Copy the URL from the browser address bar

Supported URL formats:
- `https://www.google.com/maps/place/Business+Name/@lat,lng,zoom/...`
- `https://maps.google.com/?cid=1234567890`
- `https://goo.gl/maps/...` (short links also work)

---

## n8n Integration

In your n8n workflow, the **"Scrape Competitor GBP Posts"** HTTP Request node sends:

```json
POST http://localhost:3000/scrape
{
  "url": "{{ $json.gbpUrl }}",
  "maxPosts": 10
}
```

If n8n is running on a different machine than this server, replace `localhost` with the server's IP address or hostname.

---

## Running as a Background Service (Linux/Ubuntu)

Create a systemd service so the scraper starts automatically:

```bash
sudo nano /etc/systemd/system/gbp-scraper.service
```

Paste:
```ini
[Unit]
Description=Yale IT GBP Competitor Scraper
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/path/to/gbp-scraper
ExecStart=/usr/bin/node /path/to/gbp-scraper/server.js
Restart=on-failure
Environment=PORT=3000
Environment=CHROME_PATH=/usr/bin/google-chrome

[Install]
WantedBy=multi-user.target
```

Then enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable gbp-scraper
sudo systemctl start gbp-scraper
sudo systemctl status gbp-scraper
```

---

## Troubleshooting

**"Chrome not found" error:**
Install Chrome on your server:
```bash
# Ubuntu/Debian
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

**"No posts found" from scraper:**
Google updates GBP page structure periodically. If posts aren't being detected:
- Open the GBP URL manually in a browser
- Inspect the HTML elements for the Updates/Posts tab
- Update the CSS selectors in the `postContainerSelectors` array in `server.js`

**Timeout errors:**
Increase `TIMEOUT_MS`:
```bash
TIMEOUT_MS=90000 node server.js
```

**Rate limiting from Google:**
Increase delay between batch requests:
```bash
DELAY_BETWEEN=5000 node server.js
```
