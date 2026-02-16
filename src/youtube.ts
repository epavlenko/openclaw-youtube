/**
 * YouTube Data API v3 wrapper.
 *
 * Direct port of main.py:136-353 — same API calls, same filtering logic,
 * using `googleapis` npm package instead of Python google-api-python-client.
 */

import type { youtube_v3 } from "googleapis";
import type {
  Video,
  Comment,
  ThreadReply,
  PluginConfig,
  CommentDetail,
  CommentListResult,
  ModerationStatus,
  ChannelInfo,
} from "./types.js";

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

// ============================================================
// List comments (raw, for CRUD — no AI filtering)
// ============================================================

export interface ListCommentsOptions {
  maxResults?: number;
  pageToken?: string;
  order?: "time" | "relevance";
  maxCommentAgeDays?: number;
  minCommentLength?: number;
  searchQuery?: string;
}

/**
 * List comments for a video with optional filters and pagination.
 * Unlike getComments(), this returns CommentDetail with full metadata
 * and does not filter self-comments.
 */
export async function listComments(
  youtube: youtube_v3.Youtube,
  videoId: string,
  opts: ListCommentsOptions = {},
  logger: Logger = defaultLogger,
): Promise<CommentListResult> {
  const maxResults = Math.min(opts.maxResults ?? 20, 100);
  logger.info(`Listing comments for video ${videoId} (max ${maxResults})...`);

  const video = await getVideoInfo(youtube, videoId);

  let response;
  try {
    response = await youtube.commentThreads.list({
      part: ["snippet"],
      videoId,
      maxResults,
      order: opts.order ?? "time",
      textFormat: "plainText",
      pageToken: opts.pageToken,
    });
  } catch (err) {
    logger.warn(`Could not fetch comments for ${videoId}: ${err}`);
    return { videoId, videoTitle: video.title, comments: [], totalResults: 0 };
  }

  const cutoff = opts.maxCommentAgeDays
    ? new Date(Date.now() - opts.maxCommentAgeDays * 86400000)
    : null;

  const comments: CommentDetail[] = [];

  for (const item of response.data.items ?? []) {
    const snippet = item.snippet?.topLevelComment?.snippet;
    if (!snippet) continue;

    const text = (snippet.textDisplay ?? "").trim();
    const published = snippet.publishedAt ?? "";

    if (cutoff && new Date(published) < cutoff) continue;
    if (opts.minCommentLength && text.length < opts.minCommentLength) continue;
    if (opts.searchQuery && !text.toLowerCase().includes(opts.searchQuery.toLowerCase())) continue;

    comments.push({
      id: item.snippet!.topLevelComment!.id!,
      text,
      author: snippet.authorDisplayName ?? "Unknown",
      published,
      replyCount: item.snippet!.totalReplyCount ?? 0,
      likeCount: snippet.likeCount ?? 0,
      videoId,
      authorChannelId:
        (snippet.authorChannelId as Record<string, string> | undefined)?.value ?? "",
    });
  }

  logger.info(`Listed ${comments.length} comments for video ${videoId}`);
  return {
    videoId,
    videoTitle: video.title,
    comments,
    totalResults: response.data.pageInfo?.totalResults ?? comments.length,
    nextPageToken: response.data.nextPageToken ?? undefined,
  };
}

// ============================================================
// Get single comment with thread
// ============================================================

/**
 * Fetch a single comment by ID with full thread context and video info.
 */
export async function getComment(
  youtube: youtube_v3.Youtube,
  commentId: string,
  replyAsChannelId: string,
  channelId: string,
  logger: Logger = defaultLogger,
): Promise<{
  comment: CommentDetail;
  thread: ThreadReply[];
  videoTitle: string;
  videoDescription: string;
}> {
  const response = await youtube.comments.list({
    part: ["snippet"],
    id: [commentId],
    textFormat: "plainText",
  });

  const items = response.data.items ?? [];
  if (items.length === 0) {
    throw new Error(`Comment ${commentId} not found`);
  }

  const snippet = items[0].snippet!;
  const parentId = snippet.parentId ?? undefined;

  // Determine the top-level comment ID (for thread context)
  const topLevelId = parentId ?? commentId;

  // Get thread context using a Comment-shaped object
  const threadComment: Comment = {
    id: topLevelId,
    text: (snippet.textDisplay ?? "").trim(),
    author: snippet.authorDisplayName ?? "Unknown",
    published: snippet.publishedAt ?? "",
    replyCount: parentId ? 0 : 1, // if it's a top-level comment with replies
  };

  // Fetch reply count from commentThreads if it's a top-level comment
  let replyCount = 0;
  if (!parentId) {
    try {
      const threadResponse = await youtube.commentThreads.list({
        part: ["snippet"],
        id: [commentId],
      });
      replyCount = threadResponse.data.items?.[0]?.snippet?.totalReplyCount ?? 0;
      threadComment.replyCount = replyCount;
    } catch {
      // Ignore — we'll just fetch what we can
    }
  }

  const thread = await getThreadContext(youtube, threadComment, replyAsChannelId, channelId, logger) ?? [];

  // Get video info
  const videoId = snippet.videoId ?? "";
  const video = videoId ? await getVideoInfo(youtube, videoId) : { id: "", title: "Unknown", description: "" };

  const comment: CommentDetail = {
    id: commentId,
    text: (snippet.textDisplay ?? "").trim(),
    author: snippet.authorDisplayName ?? "Unknown",
    published: snippet.publishedAt ?? "",
    replyCount,
    likeCount: snippet.likeCount ?? 0,
    videoId,
    authorChannelId:
      (snippet.authorChannelId as Record<string, string> | undefined)?.value ?? "",
    parentId,
  };

  return {
    comment,
    thread,
    videoTitle: video.title,
    videoDescription: video.description,
  };
}

// ============================================================
// Delete comment
// ============================================================

/**
 * Delete a YouTube comment. Works for own comments or comments on own videos.
 */
export async function deleteComment(
  youtube: youtube_v3.Youtube,
  commentId: string,
  logger: Logger = defaultLogger,
): Promise<boolean> {
  try {
    await youtube.comments.delete({ id: commentId });
    logger.info(`Deleted comment ${commentId}`);
    return true;
  } catch (err) {
    logger.warn(`Failed to delete comment ${commentId}: ${err}`);
    return false;
  }
}

// ============================================================
// Set moderation status
// ============================================================

/**
 * Set the moderation status of a comment.
 * Only works for comments on videos owned by the authenticated user.
 */
export async function setModerationStatus(
  youtube: youtube_v3.Youtube,
  commentId: string,
  moderationStatus: ModerationStatus,
  banAuthor: boolean = false,
  logger: Logger = defaultLogger,
): Promise<boolean> {
  try {
    await youtube.comments.setModerationStatus({
      id: [commentId],
      moderationStatus,
      banAuthor,
    });
    logger.info(`Set moderation status of ${commentId} to ${moderationStatus}`);
    return true;
  } catch (err) {
    logger.warn(`Failed to moderate comment ${commentId}: ${err}`);
    return false;
  }
}

// ============================================================
// Channel info
// ============================================================

/**
 * Get channel info with statistics.
 */
export async function getChannelInfo(
  youtube: youtube_v3.Youtube,
  channelId: string,
  logger: Logger = defaultLogger,
): Promise<ChannelInfo> {
  logger.info(`Fetching channel info for ${channelId}...`);

  const response = await youtube.channels.list({
    part: ["snippet", "statistics"],
    id: [channelId],
  });

  const items = response.data.items ?? [];
  if (items.length === 0) {
    throw new Error(`Channel ${channelId} not found`);
  }

  const item = items[0];
  const snippet = item.snippet!;
  const stats = item.statistics!;

  return {
    id: channelId,
    title: snippet.title ?? "Unknown",
    description: snippet.description ?? "",
    subscriberCount: stats.subscriberCount ?? "0",
    videoCount: stats.videoCount ?? "0",
    viewCount: stats.viewCount ?? "0",
    thumbnailUrl: snippet.thumbnails?.default?.url ?? "",
  };
}
