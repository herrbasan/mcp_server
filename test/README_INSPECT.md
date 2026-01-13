# Browser Stealth Testing

Simple tool to see what Puppeteer sees when visiting a URL.

## The One Script You Need

**inspect-url.js** - Opens a URL exactly like the scraper does, with DevTools visible.

## Usage

```bash
node test/inspect-url.js "https://www.google.com/search?q=web+scraping"
```

## What Happens

1. Opens browser with DevTools
2. Applies same stealth settings as the web scraper
3. Loads the URL
4. Shows you:
   - Console errors/warnings
   - Network requests
   - Page content
   - Detection indicators (captcha, bot blocking, etc.)
5. Keeps browser open so you can inspect visually
6. Press Ctrl+C when done

## Examples

```bash
# Test Google search
node test/inspect-url.js "https://www.google.com/search?q=puppeteer"

# Test Wikipedia
node test/inspect-url.js "https://en.wikipedia.org/wiki/Web_scraping"

# Test any site
node test/inspect-url.js "https://your-target-site.com"
```

## What to Look For

**In the terminal:**
- ❌ Console errors
- ⚠️ Warnings
- ❌ Failed network requests
- Detection indicators (captcha, unusual traffic, blocked, bot)

**In the browser:**
- Visual appearance of the page
- DevTools Console tab - JavaScript errors
- DevTools Network tab - Failed requests, blocked resources
- DevTools Elements tab - Inspect DOM

## If You See Detection

The script shows navigator properties:
- `webdriver: false` is good, `webdriver: true` means detected
- `plugins: 5` is good, `plugins: 0` looks suspicious
- `chrome object: true` is good, helps look like real Chrome

If detected, you can improve stealth in [src/servers/web-research.js](../src/servers/web-research.js) in the `setupStealthMode()` method.

---

**That's it.** One script, one purpose: see what the scraper sees.
