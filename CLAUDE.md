# CLAUDE.md

## Build & Dev

```bash
npm run build          # tsc → dist/
npm run dev            # tsc --watch
npm run test           # vitest run
npm run lint           # tsc --noEmit
npx vitest run test/state.test.ts   # single test file
```

Quick verify: `npm run lint && npm run test`

## What This Is

TypeScript plugin for the OpenClaw platform. YouTube comment moderation connector — full CRUD (list, get, reply, delete, moderate) plus AI-powered review workflow. Runs inside the OpenClaw gateway — not standalone.

## Architecture

Seven modules in `src/`, each with a single responsibility:

| Module | Role |
|---|---|
| `index.ts` | Entry point. Registers 3 grouped tools (`youtube_comments`, `youtube_channel`, `youtube_auth`) + `/yt` slash command + background polling. Action routers dispatch to handlers. |
| `types.ts` | Interfaces, `PluginConfig`, `resolveConfig()`. Action types: `CommentsAction`, `ChannelAction`. |
| `auth.ts` | Two-phase OAuth 2.0 for headless/chat environments |
| `youtube.ts` | YouTube Data API v3 wrapper. CRUD: listComments, getComment, postReply, deleteComment, setModerationStatus, getChannelInfo. Plus scanning/filtering for review workflow. |
| `state.ts` | JSON persistence of replied comment IDs |
| `identities.ts` | Loads persona files from `identities/*.txt`. Prompt templates. |
| `reply-generator.ts` | Optional dual backend: OpenClaw LLM or Gemini API. Returns `null` when unavailable. |

## Tool Structure (3 grouped tools)

- **`youtube_comments`** — action: `list` | `get` | `reply` | `delete` | `moderate` | `review` | `generate`
- **`youtube_channel`** — action: `status` | `info`
- **`youtube_auth`** — OAuth flow (no action param)

## Key Patterns

- **Tool results** — MCP-style: `{ content: [{ type: "text", text: JSON.stringify(data) }] }`
- **Action routing** — `routeCommentsAction()` / `routeChannelAction()` dispatch by `action` param to handler functions.
- **AuthRequiredError** — thrown in auth.ts, caught by `withAuthHandling()` in index.ts → returned as tool result with auth URL, never re-thrown.
- **Config extraction** — plugin config is at `api.config.plugins.entries["openclaw-youtube"].config`, not top-level.
- **Channel identity** — `channelIdentity` config binds a persona to the channel owner. Used as default for review/generate. `defaultIdentity` kept as deprecated fallback.
- **Agent-side reply generation** — when no LLM backend available, `review` action returns `proposedReply: null` + `identityPrompt`. Agent generates replies itself per `skills/youtube-comments/SKILL.md`.
- **SKIP semantics** — plugin LLM returns "SKIP" → comment marked as replied, status "skipped". Agent-side: skip decisions per SKILL.md.

## Gotchas

- **ESM `.js` extensions** — all imports must use `.js` (e.g. `import { foo } from './bar.js'`). Required by `"module": "ESNext"` + bundler resolution.
- **`@google/generative-ai` is optional** — guarded with dynamic `import()`. Don't add as hard dependency.
- **State file path** — `~/.openclaw/data/openclaw-youtube/replied_comments.json`. Format shared with Python bot.
- **YouTube API `setModerationStatus`** — `id` param must be an array `[commentId]`, not a string.

## Testing

Tests in `test/` use vitest. File I/O tests use real temp directories (no mocking filesystem). Pure logic tested with mock data objects.
