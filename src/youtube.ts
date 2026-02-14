/**
 * YouTube Data API v3 wrapper.
 *
 * Direct port of main.py:136-353 — same API calls, same filtering logic,
 * using `googleapis` npm package instead of Python google-api-python-client.
 */

import type { youtube_v3 } from "googleapis";
import type { Video, Comment, ThreadReply, PluginConfig } from "./types.js";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

const defaultLogger: Logger = {
  info: console.log,
  warn: console.warn,
  debug: () => {},
};

// ============================================================
// Fetch videos
// ============================================================

/**
 * Get recent videos from a channel.
 * Port of main.py:136-157 (get_channel_videos).
 */
export async function getChannelVideos(
  youtube: youtube_v3.Youtube,
  channelId: string,
  maxResults: number,
  logger: Logger = defaultLogger,
): Promise<Video[]> {
  logger.info(`Fetching up to ${maxResults} recent videos from channel ${channelId}...`);

  const response = await youtube.search.list({
    part: ["snippet"],
    channelId,
    maxResults,
    order: "date",
    type: ["video"],
  });

  const videos: Video[] = [];
  for (const item of response.data.items ?? []) {
    if (item.id?.videoId && item.snippet) {
      videos.push({
        id: item.id.videoId,
        title: item.snippet.title ?? "Unknown",
        description: item.snippet.description ?? "",
      });
    }
  }

  logger.info(`Found ${videos.length} videos`);
  return videos;
}

/**
 * Get video title and description by ID.
 * Port of main.py:160-172 (get_video_info).
 */
export async function getVideoInfo(
  youtube: youtube_v3.Youtube,
  videoId: string,
): Promise<Video> {
  const response = await youtube.videos.list({
    part: ["snippet"],
    id: [videoId],
  });

  const items = response.data.items ?? [];
  if (items.length === 0) {
    return { id: videoId, title: "Unknown", description: "" };
  }

  const snippet = items[0].snippet!;
  return {
    id: videoId,
    title: snippet.title ?? "Unknown",
    description: snippet.description ?? "",
  };
}

// ============================================================
// Fetch comments
// ============================================================

export interface GetCommentsOptions {
  maxResults: number;
  maxCommentAgeDays: number;
  minCommentLength: number;
  channelId: string;
  replyAsChannelId: string;
}

/**
 * Fetch top-level comments for a video, with filtering.
 * Port of main.py:175-223 (get_comments).
 *
 * Filters:
 *   - Skip old comments (maxCommentAgeDays)
 *   - Skip short comments (minCommentLength)
 *   - Skip self-comments (replyAsChannelId, channelId)
 */
export async function getComments(
  youtube: youtube_v3.Youtube,
  videoId: string,
  opts: GetCommentsOptions,
  logger: Logger = defaultLogger,
): Promise<Comment[]> {
  logger.info(`Fetching comments for video ${videoId}...`);

  let response;
  try {
    response = await youtube.commentThreads.list({
      part: ["snippet"],
      videoId,
      maxResults: Math.min(opts.maxResults, 100),
      order: "time",
      textFormat: "plainText",
    });
  } catch (err) {
    logger.warn(`Could not fetch comments for ${videoId}: ${err}`);
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - opts.maxCommentAgeDays);

  const comments: Comment[] = [];

  for (const item of response.data.items ?? []) {
    const snippet = item.snippet?.topLevelComment?.snippet;
    if (!snippet) continue;

    // Parse date
    const published = new Date(snippet.publishedAt ?? "");

    // Skip old comments
    if (published < cutoff) continue;

    // Skip very short comments
    const text = (snippet.textDisplay ?? "").trim();
    if (text.length < opts.minCommentLength) continue;

    // Skip comments by the reply account or the monitored channel (don't reply to yourself)
    const authorChannel =
      (snippet.authorChannelId as Record<string, string> | undefined)?.value ?? "";
    if (authorChannel === opts.replyAsChannelId || authorChannel === opts.channelId) {
      continue;
    }

    comments.push({
      id: item.snippet!.topLevelComment!.id!,
      text,
      author: snippet.authorDisplayName ?? "Unknown",
      published: snippet.publishedAt ?? "",
      replyCount: item.snippet!.totalReplyCount ?? 0,
    });
  }

  logger.info(`Found ${comments.length} eligible comments for video ${videoId}`);
  return comments;
}

// ============================================================
// Thread context
// ============================================================

/**
 * Fetch the reply thread for a comment and decide if we need to respond.
 * Port of main.py:226-271 (get_thread_context).
 *
 * Returns:
 *   null — if we are the last reply (nothing to do) or on error.
 *   [] (empty) — if no replies exist (new comment, no thread context).
 *   [...replies] — if thread exists and someone else replied after us.
 */
export async function getThreadContext(
  youtube: youtube_v3.Youtube,
  comment: Comment,
  replyAsChannelId: string,
  channelId: string,
  logger: Logger = defaultLogger,
): Promise<ThreadReply[] | null> {
  if (comment.replyCount === 0) {
    return []; // No thread — new comment
  }

  let items;
  try {
    const response = await youtube.comments.list({
      part: ["snippet"],
      parentId: comment.id,
      maxResults: 100,
      textFormat: "plainText",
    });
    items = response.data.items ?? [];
  } catch (err) {
    logger.warn(`Could not fetch replies for ${comment.id}: ${err}`);
    return null; // Skip on error
  }

  if (items.length === 0) {
    return [];
  }

  // Check if our reply is the last one
  const ourChannelIds = new Set([replyAsChannelId, channelId].filter(Boolean));
  const lastSnippet = items[items.length - 1].snippet;
  const lastAuthorId =
    (lastSnippet?.authorChannelId as Record<string, string> | undefined)?.value ?? "";

  if (ourChannelIds.has(lastAuthorId)) {
    return null; // We are last — nothing to add
  }

  // Build thread context
  const thread: ThreadReply[] = [];
  for (const item of items) {
    const snippet = item.snippet;
    if (!snippet) continue;
    const authorChannel =
      (snippet.authorChannelId as Record<string, string> | undefined)?.value ?? "";
    thread.push({
      author: snippet.authorDisplayName ?? "Unknown",
      text: (snippet.textDisplay ?? "").trim(),
      isOurs: ourChannelIds.has(authorChannel),
      published: snippet.publishedAt ?? "",
    });
  }

  return thread;
}

// ============================================================
// Format thread for prompt
// ============================================================

/**
 * Format a comment + its reply thread as readable text for the AI prompt.
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

// ============================================================
// Post reply
// ============================================================

/**
 * Post a reply to a YouTube comment.
 * Port of main.py:338-353 (post_reply).
 */
export async function postReply(
  youtube: youtube_v3.Youtube,
  parentCommentId: string,
  replyText: string,
  logger: Logger = defaultLogger,
): Promise<boolean> {
  try {
    await youtube.comments.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          parentId: parentCommentId,
          textOriginal: replyText,
        },
      },
    });
    return true;
  } catch (err) {
    logger.warn(`Failed to post reply to ${parentCommentId}: ${err}`);
    return false;
  }
}

// ============================================================
// Convenience: full scan for a single video
// ============================================================

export interface ScanVideoOptions {
  config: PluginConfig;
  replyAsChannelId: string;
  repliedSet: Set<string>;
}

export interface ScanTask {
  video: Video;
  comment: Comment;
  thread: ThreadReply[];
}

/**
 * Scan a single video for comments that need replies.
 * Mirrors the main loop in main.py:554-566.
 */
export async function scanVideoForTasks(
  youtube: youtube_v3.Youtube,
  video: Video,
  opts: ScanVideoOptions,
  logger: Logger = defaultLogger,
): Promise<ScanTask[]> {
  const comments = await getComments(
    youtube,
    video.id,
    {
      maxResults: opts.config.maxCommentsPerVideo,
      maxCommentAgeDays: opts.config.maxCommentAgeDays,
      minCommentLength: opts.config.minCommentLength,
      channelId: opts.config.channelId,
      replyAsChannelId: opts.replyAsChannelId,
    },
    logger,
  );

  const tasks: ScanTask[] = [];

  for (const comment of comments) {
    // Skip already-replied new comments
    if (comment.replyCount === 0 && opts.repliedSet.has(comment.id)) {
      continue;
    }

    const thread = await getThreadContext(
      youtube,
      comment,
      opts.replyAsChannelId,
      opts.config.channelId,
      logger,
    );

    if (thread === null) {
      continue; // We're already the last reply, or error
    }

    tasks.push({ video, comment, thread });
  }

  return tasks;
}
