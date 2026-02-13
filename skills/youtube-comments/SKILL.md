# YouTube Comments Management

You have access to tools for managing YouTube channel comments: scanning for new comments, generating AI replies, and posting approved replies.

## Available Tools

- `youtube_scan` — Scan channel for new comments and generate proposed replies
- `youtube_generate` — Regenerate a reply for a specific comment (with optional identity switch)
- `youtube_reply` — Post an approved reply to a specific comment
- `youtube_status` — Get plugin status, available identities, and config
- `youtube_auth` — Complete OAuth authorization with a code from the user

## Operating Modes

### Interactive Mode (default)

When the user asks to check/review comments, or says something like "проверь комментарии", "check comments", "review comments":

1. Call `youtube_scan` with `mode: "interactive"`
2. For each item in the result with `status: "pending"` and a non-null `proposedReply`, present it to the user one at a time:

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
   {proposedReply}
   ```

3. After showing each comment, ask the user what to do. Accept these responses:
   - **"ок" / "ok" / "да" / "yes" / "post" / "отправь" / "👍"** → Call `youtube_reply(commentId, proposedReply)` to post
   - **"пропусти" / "skip" / "нет" / "no"** → Skip this comment (will appear again next time)
   - **"пропусти навсегда" / "skip permanently" / "забудь"** → Call `youtube_reply` is NOT called; the comment is already marked in state
   - **"перегенерируй" / "regenerate" / "другой ответ"** → Call `youtube_generate(commentId)` and show the new reply, then ask again
   - **"перегенерируй как {identity}" / "regenerate as {identity}"** → Call `youtube_generate(commentId, identity)` with the specified identity
   - **Any other text** → Treat as a custom reply. Confirm with the user, then call `youtube_reply(commentId, customText)`

4. After processing all comments, show a summary:
   ```
   Done! Posted: {N}, Skipped: {M}, Total: {total}
   ```

### Dry-Run Mode

When the user says "покажи что ответил бы", "dry-run", "просто покажи", "preview":

1. Call `youtube_scan` with `mode: "dry-run"`
2. Show ALL comments and proposed replies at once (no need to ask for approval one by one)
3. Do NOT call `youtube_reply` — this is preview only
4. Show summary at the end

### Interactive Dry-Run Mode

When the user says "покажи по одному, но не отправляй", "interactive dry-run", "review without posting":

1. Call `youtube_scan` with `mode: "dry-run"`
2. Show comments ONE BY ONE (like interactive mode)
3. Ask for feedback on each reply, but NEVER post
4. If the user wants to regenerate, call `youtube_generate` — but still don't post

### Auto Mode

When the user says "ответь на все автоматически", "auto-reply", "авторежим", "post all":

1. Confirm with the user first: "This will automatically post replies to all new comments. Continue?"
2. If confirmed, call `youtube_scan` with `mode: "auto"`
3. All replies are posted automatically
4. Show results when done

## Identity Management

- Users can specify an identity for any scan: "проверь комментарии как volkova" → use `identity: "volkova"`
- Users can switch identity mid-review: "перегенерируй как openprophet" → call `youtube_generate(commentId, "openprophet")`
- To see available identities: call `youtube_status` or use `/yt identities`
- Default identity is set in plugin config

## Thread Handling

- When a comment has an existing thread (`isThread: true`), the `thread` array contains all replies
- Mark replies by our channel with "(you)" when displaying
- The AI-generated reply takes the full thread context into account
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
- If a comment was SKIPped by the AI (proposedReply is null), mention it briefly: "Skipped by AI (likely spam)"
- Respect the user's language — if they write in Russian, respond in Russian; if in English, respond in English
