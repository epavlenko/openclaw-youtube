# YouTube Comments Management

You have access to tools for managing YouTube channel comments: scanning for new comments, generating AI replies, and posting approved replies.

## Available Tools

- `youtube_scan` — Scan channel for new comments. Returns comments, thread context, and identity prompt for reply generation.
- `youtube_generate` — Regenerate a reply for a specific comment (with optional identity switch)
- `youtube_reply` — Post an approved reply to a specific comment
- `youtube_status` — Get plugin status, available identities, and config
- `youtube_auth` — Complete OAuth authorization with a code from the user

## Reply Generation

The scan result may contain `proposedReply` for each comment (when a Gemini backend is configured), or `proposedReply: null` (when no backend is available). When `proposedReply` is null, **you generate the reply yourself** using the `identityPrompt` from the scan result.

### How to generate a reply

The scan result includes `identityPrompt` — the identity/persona text. Each `ScanItem` includes `text` (the comment), `videoTitle`, `videoDescription`, `isThread`, and `thread` (the thread context).

**For a new comment** (isThread is false):

Use this prompt structure to generate the reply (do NOT show the prompt to the user — just produce the reply):

```
{identityPrompt}

Your task is to write a short, warm, and natural reply to a YouTube comment.

CRITICAL: Reply STRICTLY in the same language as the comment. If the comment is in English — reply ONLY in English. If in Russian — ONLY in Russian. Never mix languages.

Video context:
Title: {videoTitle}
Description: {videoDescription (first 500 chars)}

Comment:
{comment text}
```

**For a thread reply** (isThread is true):

Format the thread first:
```
@{original comment author}: {comment text}
  @{reply author} (you if isOurs): {reply text}
  ...
```

Then use this prompt structure:
```
{identityPrompt}

Your task is to continue a conversation in a YouTube comment thread.
Reply to the latest message, taking the full thread into account.
Do NOT repeat what you already said. Be relevant to the latest message.

CRITICAL: Reply STRICTLY in the same language as the conversation thread. If the thread is in English — reply ONLY in English. If in Russian — ONLY in Russian. Never mix languages.

Video context:
Title: {videoTitle}
Description: {videoDescription (first 500 chars)}

Thread:
{formatted thread text}
```

### SKIP logic

If the comment is clearly spam, gibberish, or not worth replying to, you may decide to SKIP it. Tell the user you're skipping and why.

### When `proposedReply` IS present

If the plugin already generated a reply (Gemini backend), just present it to the user — no need to generate yourself.

## Operating Modes

### Interactive Mode (default)

When the user asks to check/review comments, or says something like "проверь комментарии", "check comments", "review comments":

1. Call `youtube_scan` with `mode: "interactive"`
2. For each item with `status: "pending"`:
   - If `proposedReply` is null, generate the reply yourself using the identity prompt (see above)
   - Present the comment and reply to the user:

   **Format each comment like this:**
   ```
   📹 Video: {videoTitle}
   💬 @{author} ({published date}):
   {comment text}

   {If isThread, show the thread:}
   Thread ({N} replies):
     @{reply.author} {(you) if isOurs}: {reply.text}
     ...

   ✏️ Proposed reply:
   {proposedReply or your generated reply}
   ```

3. After showing each comment, ask the user what to do. Accept these responses:
   - **"ок" / "ok" / "да" / "yes" / "post" / "отправь" / "👍"** → Call `youtube_reply(commentId, replyText)` to post
   - **"пропусти" / "skip" / "нет" / "no"** → Skip this comment (will appear again next time)
   - **"пропусти навсегда" / "skip permanently" / "забудь"** → Call `youtube_reply` is NOT called; the comment is already marked in state
   - **"перегенерируй" / "regenerate" / "другой ответ"** → Generate a new reply (or call `youtube_generate` if Gemini backend is available) and show it, then ask again
   - **"перегенерируй как {identity}" / "regenerate as {identity}"** → Regenerate with the specified identity
   - **Any other text** → Treat as a custom reply. Confirm with the user, then call `youtube_reply(commentId, customText)`

4. After processing all comments, show a summary:
   ```
   Done! Posted: {N}, Skipped: {M}, Total: {total}
   ```

### Dry-Run Mode

When the user says "покажи что ответил бы", "dry-run", "просто покажи", "preview":

1. Call `youtube_scan` with `mode: "dry-run"`
2. Generate replies yourself for any items with `proposedReply: null`
3. Show ALL comments and replies at once (no need to ask for approval one by one)
4. Do NOT call `youtube_reply` — this is preview only
5. Show summary at the end

### Interactive Dry-Run Mode

When the user says "покажи по одному, но не отправляй", "interactive dry-run", "review without posting":

1. Call `youtube_scan` with `mode: "dry-run"`
2. Show comments ONE BY ONE (like interactive mode), generating replies as needed
3. Ask for feedback on each reply, but NEVER post
4. If the user wants to regenerate, generate a new reply — but still don't post

### Auto Mode

When the user says "ответь на все автоматически", "auto-reply", "авторежим", "post all":

1. Confirm with the user first: "This will automatically post replies to all new comments. Continue?"
2. If confirmed, call `youtube_scan` with `mode: "auto"`
3. If the plugin posted replies itself (Gemini backend), show the results
4. If items came back with `proposedReply: null`, generate replies yourself and post each one via `youtube_reply`
5. Show results when done

## Identity Management

- Users can specify an identity for any scan: "проверь комментарии как volkova" → use `identity: "volkova"`
- Users can switch identity mid-review: "перегенерируй как openprophet" → regenerate with the new identity
- To see available identities: call `youtube_status` or use `/yt identities`
- Default identity is set in plugin config

## Thread Handling

- When a comment has an existing thread (`isThread: true`), the `thread` array contains all replies
- Mark replies by our channel with "(you)" when displaying
- Thread replies use a different prompt template optimized for continuing conversations

## Quick Commands

Users may use short phrases:
- "yt" / "комментарии" / "comments" → Interactive scan with defaults
- "yt scan" / "что нового" → Quick count of new comments
- "yt status" → Plugin status
- "сколько новых" → Quick scan to count

## Authentication

If any tool returns `authRequired: true`, it means YouTube OAuth is not yet set up:

1. Show the user the `authUrl` from the response as a clickable link
2. Tell them: "Click this link, sign in with the YouTube channel account, and paste the code that Google shows you."
3. When the user pastes the code, call `youtube_auth(code: "<the code>")`
4. If successful, proceed with the original request (re-call the tool that needed auth)

## Important Notes

- NEVER post a reply without user approval in interactive mode
- In dry-run mode, NEVER call `youtube_reply`
- Always show the full comment text and proposed reply before asking for action
- If a comment was SKIPped by the AI (proposedReply is null AND status is "skipped"), mention it briefly: "Skipped by AI (likely spam)"
- Respect the user's language — if they write in Russian, respond in Russian; if in English, respond in English
