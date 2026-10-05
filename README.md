# Evidence Capture Chrome Extension

A Chrome extension to capture screenshots, network calls, and screen recordings as evidence, and download them all as a ZIP file.

## Features
- **Screenshots**: Capture the active tab.
- **Screen Recording**: Record the tab screen as a video.
- **Network Capture**: Log all network requests and responses (including headers and bodies) using the Chrome DevTools Protocol.
- **Export to ZIP**: Download all evidence safely into a well-structured ZIP file.
- **Timeline Viewer**: View network logs alongside screenshots and playback recordings in sync.

## Development

1. Run tests:
   ```bash
   npm install
   npm test
   ```

2. Load locally in Chrome:
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select this directory.

## How to Package the Extension

To create a `.zip` file that can be distributed or uploaded to the Chrome Web Store, zip the contents of this folder, excluding development files like tests and `node_modules`.

**Using Linux / macOS Terminal:**
Run the following command in the root of the project directory:
```bash
zip -r evidence-capture-extension.zip . -x "*.git*" -x "node_modules/*" -x "tests/*" -x "package.json" -x "package-lock.json" -x "*.md" -x ".gitignore"
```

**Using Windows:**
1. Select all the essential extension files (`manifest.json`, `*.html`, `*.js`, `*.css`, `icon.png`, etc.)
2. Right-click and select **Compress to ZIP file**.
3. *Note: Do not include `node_modules` or the `tests` folder.*

This will create an `evidence-capture-extension.zip` file which you can upload to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
