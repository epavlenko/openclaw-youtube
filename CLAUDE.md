# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run build          # tsc → dist/
npm run dev            # tsc --watch
npm run test           # vitest run (all tests)
npm run test:watch     # vitest (watch mode)
npm run lint           # tsc --noEmit (type check only)
npx vitest run test/state.test.ts   # run a single test file
```

## What This Is

TypeScript plugin for the OpenClaw platform that automates YouTube comment management with AI-generated replies. Ported from a Python bot (`youtube-auto-reply`). Runs as a plugin inside the OpenClaw gateway — not standalone.

## Architecture

Seven modules in `src/`, each with a single responsibility:

- **index.ts** — Entry point. Exports `register(api)` which registers 5 tools (`youtube_scan`, `youtube_generate`, `youtube_reply`, `youtube_status`, `youtube_auth`), a `/yt` slash command, and a background polling service. Holds session state (YouTube client, channel ID, replied set, config) in module-scoped variables.
- **types.ts** — All interfaces (`Video`, `Comment`, `ThreadReply`, `ScanItem`, `ScanResult`, `PluginConfig`, OpenClaw API types) and `resolveConfig()` for applying defaults.
- **auth.ts** — Two-phase OAuth 2.0 designed for headless/chat environments. Phase 1: no token → throw `AuthRequiredError` with auth URL. Phase 2: user pastes code → `completeOAuth()` exchanges it. Supports both native and Python bot token formats.
- **youtube.ts** — YouTube Data API v3 wrapper. Comment filtering (age, length, self-comments), thread context building, `scanVideoForTasks()` orchestration.
- **state.ts** — JSON persistence of replied comment IDs at `~/.openclaw/data/openclaw-youtube/replied_comments.json`. Format compatible with the Python bot.
- **identities.ts** — Loads persona files from `identities/*.txt` (metadata + `---` separator + prompt text). Builds prompts using `PROMPT_NEW_COMMENT` / `PROMPT_THREAD_REPLY` templates with placeholder substitution.
- **reply-generator.ts** — Optional dual backend: OpenClaw LLM (`api.runtime.llm.generate()`) or direct Gemini API (`@google/generative-ai`). Returns `null` gracefully when no backend is available (agent generates replies itself). `@google/generative-ai` is an optional dependency.

## Key Patterns

- **Tool results** are MCP-style: `{ content: [{ type: "text", text: JSON.stringify(data) }] }`
- **AuthRequiredError** is a custom error caught by `withAuthHandling()` in index.ts and returned as a friendly tool result with the auth URL — not re-thrown.
- **ESM with `.js` extensions** in imports (required by `"module": "ESNext"` + bundler resolution).
- **Config extraction**: `api.config` is the full OpenClaw gateway config; plugin config lives at `plugins.entries.openclaw-youtube.config` and is extracted in `register()`.
- **Three operating modes**: `interactive` (default, one-by-one approval), `dry-run` (preview only), `auto` (post all with random delays).
- **Agent-side reply generation**: when no Gemini key / OpenClaw LLM is available, `youtube_scan` returns `proposedReply: null` + `identityPrompt` in `ScanResult`. The agent generates replies itself using the identity prompt and comment context from `ScanItem` (including `videoDescription`). See `skills/youtube-comments/SKILL.md` for the agent's reply generation instructions.
- **SKIP semantics**: when the plugin's LLM returns "SKIP", the comment is marked as replied (so it won't be re-processed) and status is set to "skipped". When the agent generates replies itself, it decides to skip based on SKILL.md instructions.
- **Thread-aware prompting**: different prompt templates for new comments vs. continuing existing threads.
- **Identity personas** in `identities/`: `volkova.txt` (Nastya, cinematic electronic travel) and `openprophet.txt` (Eugene, tech/dev persona).

## Testing

Tests in `test/` use vitest. File I/O tests use real temp directories (no mocking filesystem). Pure logic tested with mock data objects. No mocking of external APIs.
