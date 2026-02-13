# OpenClaw YouTube Comments Plugin

OpenClaw plugin for managing YouTube channel comments — scan for new comments, generate AI replies, and post with an approval workflow via Telegram.

## Features

- **Interactive mode** — review and approve each reply one by one via Telegram
- **Dry-run mode** — preview all generated replies without posting
- **Auto mode** — automatically post replies to all new comments
- **Multiple identities** — switch between personas (e.g. `volkova`, `openprophet`)
- **Thread support** — continue conversations in existing comment threads
- **Dual AI backend** — use OpenClaw's connected model or direct Gemini API
- **Background polling** — automatic periodic checks for new comments
- **`/yt` slash command** — quick status without consuming AI tokens

## Installation

1. Clone this repository into your OpenClaw plugins directory
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build:
   ```bash
   npm run build
   ```
4. Add to your `openclaw.json`:
   ```json
   {
     "plugins": {
       "youtube-comments": {
         "path": "/path/to/openclaw-youtube",
         "config": {
           "channelId": "UCxxxxxxxxxxxxxxxx",
           "oauthCredentialsPath": "/path/to/client_secret.json"
         }
       }
     }
   }
   ```

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `channelId` | string | *required* | YouTube channel ID to monitor |
| `videoIds` | string[] | — | Specific video IDs (overrides maxRecentVideos) |
| `maxRecentVideos` | number | 5 | Recent videos to check |
| `maxCommentsPerVideo` | number | 50 | Max comments per video |
| `maxCommentAgeDays` | number | 7 | Ignore older comments |
| `minCommentLength` | number | 3 | Skip short comments |
| `defaultIdentity` | string | "volkova" | Default persona |
| `replyDelayMin` / `replyDelayMax` | number | 10 / 60 | Auto-mode delay (seconds) |
| `oauthCredentialsPath` | string | — | Path to Google OAuth `client_secret.json` |
| `oauthTokenPath` | string | auto | Where to store OAuth token |
| `geminiApiKey` | string | — | Direct Gemini API key (optional) |
| `geminiModel` | string | "gemini-2.0-flash" | Gemini model when using direct API |
| `pollIntervalMinutes` | number | 120 | Background polling interval (0 = disabled) |

## OAuth Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **YouTube Data API v3**
3. Create OAuth 2.0 credentials (Desktop app type)
4. Download `client_secret.json`
5. Set `oauthCredentialsPath` in plugin config
6. On first use, a browser window will open for authentication

## Usage

Via Telegram (or any OpenClaw chat interface):

- **"Check comments"** — interactive scan with approval for each reply
- **"Dry run"** — preview replies without posting
- **"Auto reply all"** — post all replies automatically
- **"Check comments as openprophet"** — use a different identity
- **`/yt`** — quick status
- **`/yt scan`** — count new comments
- **`/yt identities`** — list available identities

## Identities

Identity files in `identities/` define the persona and tone:

- `volkova.txt` — Nastya / VOLKOVA channel persona
- `openprophet.txt` — Eugene / tech-oriented persona

Format: metadata header (name, handle, channel) separated by `---` from the prompt text.

## Development

```bash
npm run dev      # Watch mode
npm run test     # Run tests
npm run lint     # Type check
```

## Architecture

```
src/
  index.ts              # Plugin entry — registers tools, commands, service
  auth.ts               # OAuth 2.0 flow for YouTube
  youtube.ts            # YouTube Data API wrapper
  state.ts              # Replied comments tracking (JSON)
  identities.ts         # Identity loader + prompt templates
  reply-generator.ts    # Dual backend: OpenClaw model / Gemini API
  types.ts              # TypeScript interfaces
```

## License

MIT
