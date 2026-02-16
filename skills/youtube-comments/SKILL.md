# YouTube Comment Moderation

You have access to tools for managing YouTube channel comments: listing, viewing, replying, deleting, moderating, and AI-powered review workflows.

## Available Tools

### `youtube_comments` (action-based)

| Action | Description | Required params |
|--------|-------------|-----------------|
| `list` | List comments for a video | `videoId` |
| `get` | Get comment by ID with full thread | `commentId` |
| `reply` | Post reply to a comment | `commentId`, `text` |
| `delete` | Delete a comment | `commentId` |
| `moderate` | Set moderation status | `commentId`, `moderationStatus` |
| `review` | AI-powered scan & reply workflow | (optional: `videoId`, `mode`, `identity`, `limit`) |
| `generate` | Regenerate AI reply for a comment | `commentId` |

### `youtube_channel` (action-based)

| Action | Description |
|--------|-------------|
| `status` | Plugin status, config, available identities |
| `info` | Channel info with subscriber/video/view stats |
| `videos` | List recent channel videos (optional: `maxVideos`) |

### `youtube_auth`

Complete OAuth authorization with a code from the user.

## Channel Identity

The plugin binds a channel to an identity (persona). The `channelIdentity` config field sets the default persona for reply generation. This ensures the agent knows "who" is replying and avoids replying to own comments.

- Default identity is used automatically for `review` and `generate`
- Can be overridden per-request with the `identity` parameter
- Available identities: check via `youtube_channel` action `status`

## Comment CRUD Operations

### Listing Comments

When the user asks to see comments on a video:

1. Call `youtube_comments` with `{ action: "list", videoId: "<id>" }`
2. Optional filters: `searchQuery`, `maxCommentAgeDays`, `minCommentLength`, `order` ("time" or "relevance")
3. Optional pagination: `limit`, `pageToken`
4. Present results in a readable format

### Viewing a Comment

When the user asks about a specific comment:

1. Call `youtube_comments` with `{ action: "get", commentId: "<id>" }`
2. Shows the comment text, author, date, like count, and full thread context

### Deleting a Comment

**IMPORTANT: Always confirm with the user before deleting.**

1. Show the comment content to the user first
2. Ask for explicit confirmation
3. Only then call `youtube_comments` with `{ action: "delete", commentId: "<id>" }`
4. Report success or failure

### Moderating a Comment

Moderation statuses: `published`, `heldForReview`, `rejected`

1. Call `youtube_comments` with `{ action: "moderate", commentId: "<id>", moderationStatus: "<status>" }`
2. Optional: `banAuthor: true` to also ban the author
3. **Confirm before rejecting or banning** — these are significant actions

## AI Reply Review Workflow

### Video Selection (always first)

Before starting any review, **always let the user choose a video**:

1. Call `youtube_channel` with `{ action: "videos" }` — returns only videos that have unanswered comments, with `pendingComments` count for each
2. If no videos have pending comments, tell the user: "No unanswered comments found."
3. If there are videos, present them as a numbered list:
   ```
   Видео с неотвеченными комментариями:
   1. 🎬 "Video Title 1" — 5 новых комментариев
   2. 🎬 "Video Title 2" — 2 новых комментария

   Выбери номер или "все".
   ```
4. Wait for the user's choice:
   - A number (e.g. "2") → use that video's ID as `videoId` in the review call
   - "все" / "all" → omit `videoId` to review all videos
5. Then proceed with the review action using the chosen `videoId`

### Interactive Mode (default)

When the user asks to check/review comments, or says "проверь комментарии", "check comments", "review comments":

1. Show the video picker (see above)
2. Call `youtube_comments` with `{ action: "review", mode: "interactive", videoId: "<chosen>" }`
2. For each item with `status: "pending"`:
   - If `proposedReply` is null, generate the reply yourself using the identity prompt (see below)
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
   - **"ок" / "ok" / "да" / "yes" / "post" / "отправь" / "👍"** → Call `youtube_comments` with `{ action: "reply", commentId, text: replyText }`
   - **"пропусти" / "skip" / "нет" / "no"** → Skip this comment (will appear again next time)
   - **"пропусти навсегда" / "skip permanently" / "забудь"** → Skip permanently (already marked in state)
   - **"перегенерируй" / "regenerate" / "другой ответ"** → Generate a new reply (or call `youtube_comments` with `{ action: "generate", commentId }`) and show it, then ask again
   - **"перегенерируй как {identity}" / "regenerate as {identity}"** → Regenerate with the specified identity
   - **"удали" / "delete"** → Confirm, then call `youtube_comments` with `{ action: "delete", commentId }`
   - **Any other text** → Treat as a custom reply. Confirm with the user, then post it

4. After processing all comments, show a summary:
   ```
   Done! Posted: {N}, Skipped: {M}, Deleted: {D}, Total: {total}
   ```

### Dry-Run Mode

When the user says "покажи что ответил бы", "dry-run", "просто покажи", "preview":

1. Show the video picker (see above)
2. Call `youtube_comments` with `{ action: "review", mode: "dry-run", videoId: "<chosen>" }`
2. Generate replies yourself for any items with `proposedReply: null`
3. Show ALL comments and replies at once (no need to ask for approval one by one)
4. Do NOT post anything — this is preview only
5. Show summary at the end

### Auto Mode

When the user says "ответь на все автоматически", "auto-reply", "авторежим", "post all":

1. Show the video picker (see above)
2. Confirm with the user: "This will automatically post replies to all new comments. Continue?"
3. If confirmed, call `youtube_comments` with `{ action: "review", mode: "auto", videoId: "<chosen>" }`
3. If the plugin posted replies itself (Gemini backend), show the results
4. If items came back with `proposedReply: null`, generate replies yourself and post each one via `youtube_comments` with `{ action: "reply", commentId, text }`
5. Show results when done

## Reply Generation

The review result may contain `proposedReply` for each comment (when a Gemini backend is configured), or `proposedReply: null` (when no backend is available). When `proposedReply` is null, **you generate the reply yourself** using the `identityPrompt` from the scan result.

### How to generate a reply

The review result includes `identityPrompt` — the identity/persona text. Each `ScanItem` includes `text` (the comment), `videoTitle`, `videoDescription`, `isThread`, and `thread` (the thread context).

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

Determine who you're replying to: the last non-"(you)" author in the thread.

Then use this prompt structure:
```
{identityPrompt}

Your task is to continue a conversation in a YouTube comment thread.
Reply to the latest message, taking the full thread into account.
Do NOT repeat what you already said. Be relevant to the latest message.

IMPORTANT: Start your reply with @{replyToAuthor} to indicate who you are replying to in the thread.

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

## Identity Management

- Users can specify an identity for any review: "проверь комментарии как volkova" → use `identity: "volkova"`
- Users can switch identity mid-review: "перегенерируй как openprophet" → regenerate with the new identity
- To see available identities: call `youtube_channel` with `{ action: "status" }` or use `/yt identities`
- Default identity is the channel identity set in plugin config

## Thread Handling

- When a comment has an existing thread (`isThread: true`), the `thread` array contains all replies
- Mark replies by our channel with "(you)" when displaying
- Thread replies use a different prompt template optimized for continuing conversations

## Slash Commands

Users can invoke actions directly via `/yt`:
- `/yt` — channel status & config
- `/yt reply` — review & reply to comments (shows video picker first)
- `/yt reply dry` — preview replies without posting
- `/yt reply auto` — auto-reply to all comments
- `/yt videos` — list recent channel videos
- `/yt list <videoId>` — list comments for a video
- `/yt get <commentId>` — view a comment with thread
- `/yt delete <commentId>` — delete a comment
- `/yt moderate <commentId> <status>` — moderate a comment
- `/yt info` — channel info with stats
- `/yt identities` — list available personas
- `/yt help` — show all commands

Options for `/yt reply`: `as <identity>`, `limit <N>`

Natural language also works: "проверь комментарии", "check comments", "preview replies", "покажи комментарии к видео ...", etc.

## Authentication

If any tool returns `authRequired: true`, it means YouTube OAuth is not yet set up:

1. Show the user the `authUrl` from the response as a clickable link
2. Tell them: "Click this link, sign in with the YouTube channel account, and paste the code that Google shows you."
3. When the user pastes the code, call `youtube_auth` with `{ code: "<the code>" }`
4. If successful, proceed with the original request (re-call the tool that needed auth)

## Important Notes

- NEVER post a reply without user approval in interactive mode
- NEVER delete or reject a comment without user confirmation
- In dry-run mode, NEVER call reply/delete/moderate actions
- Always show the full comment text and proposed reply before asking for action
- If a comment was SKIPped by the AI (proposedReply is null AND status is "skipped"), mention it briefly: "Skipped by AI (likely spam)"
- Respect the user's language — if they write in Russian, respond in Russian; if in English, respond in English
