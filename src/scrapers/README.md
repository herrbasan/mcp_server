# Scraper System

Site-specific scraping strategies for improved stealth.

## Architecture

```
src/scrapers/
├── index.js           # ScraperRegistry - routes URLs to scrapers
├── google-search.js   # Google-specific human-like behavior
└── generic.js         # Fallback for all other sites
```

## How It Works

**ScraperRegistry** automatically picks the right scraper for each URL:
- Google search URLs → `GoogleSearchScraper` (human-like behavior)
- Everything else → `GenericScraper` (direct navigation)

**Each scrape gets a fresh browser instance** - prevents tracking across requests.

## Google Search Scraper

Instead of directly accessing search results URL, it:
1. Goes to google.com homepage (with `?hl=en&gl=us` for English)
2. Waits 800-1500ms (looks human)
3. Handles cookie dialog automatically
4. Waits 500-1200ms
5. Finds search box
6. Clicks and types query with 50-150ms delays per keystroke
7. Waits 300-800ms
8. Presses Enter
9. Waits for results

Much stealthier than direct URL access.

## Usage in Web Research

Automatically integrated - no code changes needed:

```javascript
// In web-research.js scrapePageIsolated():
// Old:
// await page.goto(url, { waitUntil: 'domcontentloaded' });

// New:
const html = await this.scraperRegistry.scrapeUrl(url, page);
// Automatically uses GoogleSearchScraper for Google, GenericScraper for others
```

## Adding New Site-Specific Scrapers

Create `src/scrapers/site-name.js`:

```javascript
export class SiteNameScraper {
  constructor() {
    this.name = 'SiteNameScraper';
    this.domains = ['example.com'];
  }

  canHandle(url) {
    return this.domains.some(d => url.includes(d));
  }

  async scrape(url, page) {
    // Custom scraping logic
    await page.goto(url);
    return await page.content();
  }
}
```

Register in `src/scrapers/index.js`:

```javascript
import { SiteNameScraper } from './site-name.js';

this.scrapers = [
  new GoogleSearchScraper(),
  new SiteNameScraper(),  // Add here
  new GenericScraper()    // Keep as fallback
];
```

## Testing

```bash
# Test registry routing
node test/test-scraper-registry.js

# Test visually
node test/inspect-url.js "your search query"
```

## Restart Service

After changes: **restart the service in your separate terminal**

Remember: Service runs independently, changes require manual restart.
