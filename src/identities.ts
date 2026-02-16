/**
 * Identity loader and prompt templates.
 *
 * Port of config.py:99-117 (load_identity, list_identities)
 * and config.py:65-96 (PROMPT_NEW_COMMENT, PROMPT_THREAD_REPLY).
 *
 * Identity files live in the plugin's identities/ directory and use the
 * same format as the Python bot: metadata above '---', prompt text below.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import type { Comment, ThreadReply, Video } from "./types.js";

// ============================================================
// Prompt templates — exact copies from config.py:65-96
// ============================================================

/**
 * Prompt for new comments (no existing thread).
 * Port of config.py PROMPT_NEW_COMMENT.
 */
export const PROMPT_NEW_COMMENT = `{identity}

Your task is to write a short, warm, and natural reply to a YouTube comment.

CRITICAL: Reply STRICTLY in the same language as the comment. If the comment is in English — reply ONLY in English. If in Russian — ONLY in Russian. Never mix languages.

Video context:
Title: {video_title}
Description: {video_description}

Comment:
{comment_text}

Reply:`;

/**
 * Prompt for continuing a thread (replies already exist).
 * Port of config.py PROMPT_THREAD_REPLY.
 */
export const PROMPT_THREAD_REPLY = `{identity}

Your task is to continue a conversation in a YouTube comment thread.
Reply to the latest message, taking the full thread into account.
Do NOT repeat what you already said. Be relevant to the latest message.

IMPORTANT: Start your reply with @{reply_to_author} to indicate who you are replying to in the thread.

CRITICAL: Reply STRICTLY in the same language as the conversation thread. If the thread is in English — reply ONLY in English. If in Russian — ONLY in Russian. Never mix languages.

Video context:
Title: {video_title}
Description: {video_description}

Thread:
{thread_text}

Your reply to {reply_to_author}:`;

// ============================================================
// Identity loading
// ============================================================

/** Resolve the identities directory relative to the plugin root. */
function getIdentitiesDir(): string {
  // In a built plugin, __dirname points to dist/
  // Identities are in the plugin root's identities/ folder
  const pluginRoot = join(new URL(".", import.meta.url).pathname, "..");
  return join(pluginRoot, "identities");
}

/**
 * Load identity text from identities/<name>.txt.
 * Returns the part after '---' separator.
 *
 * Port of config.py:99-112 (load_identity).
 */
export async function loadIdentity(name: string): Promise<string> {
  const dir = getIdentitiesDir();
  const filePath = join(dir, `${name}.txt`);

  if (!existsSync(filePath)) {
    const available = await listIdentities();
    throw new Error(
      `Identity '${name}' not found at ${filePath}\n` +
        `Available identities: ${available.join(", ") || "(none)"}`,
    );
  }

  let text = await readFile(filePath, "utf-8");

  // Use content after --- separator (the actual prompt part)
  if (text.includes("\n---\n")) {
    text = text.split("\n---\n")[1];
  }

  return text.trim();
}

/**
 * List available identity names (without .txt extension).
 * Port of config.py:115-117 (list_identities).
 */
export async function listIdentities(): Promise<string[]> {
  const dir = getIdentitiesDir();
  if (!existsSync(dir)) {
    return [];
  }

  const files = await readdir(dir);
  return files
    .filter((f) => extname(f) === ".txt")
    .map((f) => basename(f, ".txt"))
    .sort();
}

// ============================================================
// Prompt building
// ============================================================

/**
 * Build the prompt for a new comment (no thread).
 * Port of the format() call in main.py:305-310.
 */
export function buildNewCommentPrompt(
  identity: string,
  video: Video,
  commentText: string,
): string {
  return PROMPT_NEW_COMMENT
    .replace("{identity}", identity)
    .replace("{video_title}", video.title)
    .replace("{video_description}", video.description.slice(0, 500))
    .replace("{comment_text}", commentText);
}

/**
 * Build the prompt for a thread reply.
 * Port of the format() call in main.py:298-303.
 *
 * @param replyToAuthor — display name of the last non-our commenter in the thread
 */
export function buildThreadReplyPrompt(
  identity: string,
  video: Video,
  threadText: string,
  replyToAuthor: string = "user",
): string {
  return PROMPT_THREAD_REPLY
    .replace("{identity}", identity)
    .replace("{video_title}", video.title)
    .replace("{video_description}", video.description.slice(0, 500))
    .replace("{thread_text}", threadText)
    .replace(/\{reply_to_author\}/g, replyToAuthor);
}

/**
 * Get the display name of the last person we should reply to in a thread.
 * Finds the last non-our reply; falls back to the original comment author.
 */
export function getReplyToAuthor(comment: Comment, thread: ThreadReply[]): string {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (!thread[i].isOurs) {
      return thread[i].author;
    }
  }
  return comment.author;
}

/**
 * Format a comment + its reply thread as readable text for the prompt.
 * Port of main.py:274-280 (format_thread_for_prompt).
 */
export function formatThreadForPrompt(
  comment: Comment,
  thread: ThreadReply[],
): string {
  const lines: string[] = [`@${comment.author}: ${comment.text}`];
  for (const reply of thread) {
    const marker = reply.isOurs ? " (you)" : "";
    lines.push(`  @${reply.author}${marker}: ${reply.text}`);
  }
  return lines.join("\n");
}
