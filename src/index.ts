/**
 * OpenClaw YouTube Comments Plugin — entry point.
 *
 * Registers:
 *   - 3 agent tools: youtube_comments, youtube_channel, youtube_auth
 *   - /yt slash command
 *   - Background polling service
 */

import type { youtube_v3 } from "googleapis";
import type {
  OpenClawPluginApi,
  PluginConfig,
  ScanItem,
  ScanResult,
  ScanMode,
  Video,
  Comment,
  ThreadReply,
  ToolResult,
  CommentsAction,
  ChannelAction,
  ModerationStatus,
  CommentListResult,
  CommentDetail,
  ChannelInfo,
  DeleteResult,
  ModerateResult,
} from "./types.js";
import { resolveConfig } from "./types.js";
import { getYouTubeService, getAuthenticatedChannelId, AuthRequiredError, completeOAuth } from "./auth.js";
import {
  getChannelVideos,
  getVideoInfo,
  scanVideoForTasks,
  postReply,
  listComments,
  getComment,
  deleteComment,
  setModerationStatus,
  getChannelInfo,
} from "./youtube.js";
import { loadState, saveState, markReplied } from "./state.js";
import { loadIdentity, listIdentities, buildNewCommentPrompt, buildThreadReplyPrompt, formatThreadForPrompt, getReplyToAuthor } from "./identities.js";
import { generateReply, detectBackend } from "./reply-generator.js";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================
// Plugin state (shared across tools within a session)
// ============================================================

let youtube: youtube_v3.Youtube | null = null;
let replyAsChannelId: string | null = null;
let repliedSet: Set<string> = new Set();
let pluginConfig: PluginConfig;
let pluginApi: OpenClawPluginApi;
let lastScanTime: string | null = null;

/** State file path — defaults to ~/.openclaw/data/openclaw-youtube/replied_comments.json */
function getStatePath(): string {
  return join(homedir(), ".openclaw", "data", "openclaw-youtube", "replied_comments.json");
}

/** Token path */
function getTokenPath(config: PluginConfig): string {
  return config.oauthTokenPath ?? join(homedir(), ".openclaw", "data", "openclaw-youtube", "token.json");
}

// ============================================================
// Initialization helper
// ============================================================

async function ensureInitialized(): Promise<void> {
  const log = pluginApi.logger;

  if (!pluginConfig.channelId) {
    throw new Error(
      "channelId is not configured. Set it in plugins.entries.openclaw-youtube.config.channelId",
    );
  }

  if (!youtube) {
    const credPath = pluginConfig.oauthCredentialsPath;
    if (!credPath) {
      throw new Error(
        "oauthCredentialsPath is not configured. Set it in plugins.entries.openclaw-youtube.config.oauthCredentialsPath",
      );
    }
    youtube = await getYouTubeService(credPath, getTokenPath(pluginConfig), log);
  }

  if (!replyAsChannelId) {
    replyAsChannelId = await getAuthenticatedChannelId(youtube);
    if (!replyAsChannelId) {
      throw new Error("Could not determine authenticated channel ID. Re-run OAuth setup.");
    }
    pluginApi.logger.info(`Authenticated as channel ${replyAsChannelId}`);
  }

  if (repliedSet.size === 0) {
    repliedSet = await loadState(getStatePath());
    pluginApi.logger.info(`Loaded ${repliedSet.size} previously replied comments`);
  }
}

// ============================================================
// Handler: review (formerly youtube_scan)
// ============================================================

async function handleReview(params: Record<string, unknown>): Promise<ScanResult> {
  await ensureInitialized();
  const log = pluginApi.logger;

  const mode = (params.mode as ScanMode) ?? "interactive";
  const identityName = (params.identity as string) ?? pluginConfig.channelIdentity;
  const limit = params.limit as number | undefined;
  const maxVideos = (params.maxVideos as number) ?? pluginConfig.maxRecentVideos;
  const maxComments = (params.maxComments as number) ?? pluginConfig.maxCommentsPerVideo;

  const videoId = params.videoId as string | undefined;

  log.info(`review: mode=${mode}, identity=${identityName}, limit=${limit ?? "none"}, videoId=${videoId ?? "all"}`);

  // Get videos to check
  let videos: Video[];
  if (videoId) {
    // Single video specified — use only this one
    videos = [await getVideoInfo(youtube!, videoId)];
  } else if (pluginConfig.videoIds && pluginConfig.videoIds.length > 0) {
    videos = await Promise.all(pluginConfig.videoIds.map((id) => getVideoInfo(youtube!, id)));
  } else {
    videos = await getChannelVideos(youtube!, pluginConfig.channelId, maxVideos, log);
  }

  // Load identity text once for the entire scan
  const identityText = await loadIdentity(identityName);
  const hasBackend = detectBackend(pluginConfig, pluginApi) !== null;

  if (videos.length === 0) {
    return { mode, identity: identityName, identityPrompt: identityText, found: 0, items: [] };
  }

  // Scan all videos for tasks
  const allTasks: { video: Video; comment: Comment; thread: ThreadReply[] }[] = [];
  for (const video of videos) {
    log.info(`Scanning: ${video.title} (${video.id})`);
    const tasks = await scanVideoForTasks(youtube!, video, {
      config: { ...pluginConfig, maxCommentsPerVideo: maxComments },
      replyAsChannelId: replyAsChannelId!,
      repliedSet,
    }, log);
    allTasks.push(...tasks);
  }

  // Apply limit
  const tasksToProcess = limit ? allTasks.slice(0, limit) : allTasks;

  // Generate replies for each task (only when a backend is available)
  const items: ScanItem[] = [];
  for (const task of tasksToProcess) {
    const isThread = task.thread.length > 0;

    // When no backend, skip plugin-side generation — agent will generate via identityPrompt
    let proposedReply: string | null = null;
    if (hasBackend) {
      proposedReply = await generateReply({
        comment: task.comment,
        video: task.video,
        thread: task.thread,
        identityName,
        config: pluginConfig,
        api: pluginApi,
        logger: log,
      });
    }

    if (hasBackend && proposedReply === null) {
      // Model said SKIP — mark as replied so we don't ask again
      repliedSet.add(task.comment.id);
      items.push({
        commentId: task.comment.id,
        author: task.comment.author,
        text: task.comment.text,
        videoTitle: task.video.title,
        videoDescription: task.video.description,
        videoId: task.video.id,
        published: task.comment.published,
        isThread,
        thread: task.thread,
        proposedReply: null,
        status: "skipped",
      });
      continue;
    }

    // In auto mode with a backend, post immediately
    if (mode === "auto" && proposedReply) {
      // Random delay to look natural
      const delay = randomInt(pluginConfig.replyDelayMin, pluginConfig.replyDelayMax);
      log.info(`Auto mode: waiting ${delay}s before posting...`);
      await sleep(delay * 1000);

      const success = await postReply(youtube!, task.comment.id, proposedReply, log);
      if (success) {
        await markReplied(getStatePath(), repliedSet, task.comment.id);
        items.push({
          commentId: task.comment.id,
          author: task.comment.author,
          text: task.comment.text,
          videoTitle: task.video.title,
          videoDescription: task.video.description,
          videoId: task.video.id,
          published: task.comment.published,
          isThread,
          thread: task.thread,
          proposedReply,
          status: "posted",
        });
      } else {
        items.push({
          commentId: task.comment.id,
          author: task.comment.author,
          text: task.comment.text,
          videoTitle: task.video.title,
          videoDescription: task.video.description,
          videoId: task.video.id,
          published: task.comment.published,
          isThread,
          thread: task.thread,
          proposedReply,
          status: "pending",
        });
      }
    } else {
      // dry-run, interactive, or auto without backend: return pending items
      items.push({
        commentId: task.comment.id,
        author: task.comment.author,
        text: task.comment.text,
        videoTitle: task.video.title,
        videoDescription: task.video.description,
        videoId: task.video.id,
        published: task.comment.published,
        isThread,
        thread: task.thread,
        proposedReply,
        status: "pending",
      });
    }
  }

  // Save state (skipped items already added above)
  if (mode !== "auto") {
    // In non-auto modes, only save skip markers
    await saveState(getStatePath(), repliedSet);
  }

  lastScanTime = new Date().toISOString();

  return {
    mode,
    identity: identityName,
    identityPrompt: identityText,
    found: items.length,
    items,
  };
}

// ============================================================
// Handler: generate (regenerate AI reply)
// ============================================================

async function handleGenerate(params: Record<string, unknown>): Promise<{
  commentId: string;
  proposedReply: string | null;
  prompt: string | null;
  identity: string;
}> {
  await ensureInitialized();
  const log = pluginApi.logger;

  const commentId = params.commentId as string;
  const identityName = (params.identity as string) ?? pluginConfig.channelIdentity;

  if (!commentId) {
    throw new Error("commentId is required");
  }

  log.info(`generate: commentId=${commentId}, identity=${identityName}`);

  // Fetch the comment and its context for regeneration
  const threadResponse = await youtube!.comments.list({
    part: ["snippet"],
    id: [commentId],
  });

  const commentItem = threadResponse.data.items?.[0];
  if (!commentItem?.snippet) {
    throw new Error(`Comment ${commentId} not found`);
  }

  const parentId = commentItem.snippet.parentId ?? commentId;
  const isReplyToReply = !!commentItem.snippet.parentId;

  // Get the top-level comment
  let topLevelCommentId = parentId;
  let topLevelSnippet = commentItem.snippet;

  if (isReplyToReply) {
    const parentResponse = await youtube!.comments.list({
      part: ["snippet"],
      id: [parentId],
    });
    if (parentResponse.data.items?.[0]?.snippet) {
      topLevelSnippet = parentResponse.data.items[0].snippet;
      topLevelCommentId = parentId;
    }
  }

  // Get video info
  const videoId = topLevelSnippet.videoId ?? "";
  const videoInfo = await getVideoInfo(youtube!, videoId);

  // Build a Comment object
  const comment: Comment = {
    id: topLevelCommentId,
    text: (topLevelSnippet.textDisplay ?? "").trim(),
    author: topLevelSnippet.authorDisplayName ?? "Unknown",
    published: topLevelSnippet.publishedAt ?? "",
    replyCount: 0,
  };

  // Fetch thread context
  let thread: ThreadReply[] = [];
  try {
    const repliesResponse = await youtube!.comments.list({
      part: ["snippet"],
      parentId: topLevelCommentId,
      maxResults: 100,
      textFormat: "plainText",
    });

    const ourChannelIds = new Set(
      [replyAsChannelId!, pluginConfig.channelId].filter(Boolean),
    );

    for (const item of repliesResponse.data.items ?? []) {
      const s = item.snippet;
      if (!s) continue;
      const authorChannel =
        (s.authorChannelId as Record<string, string> | undefined)?.value ?? "";
      thread.push({
        author: s.authorDisplayName ?? "Unknown",
        text: (s.textDisplay ?? "").trim(),
        isOurs: ourChannelIds.has(authorChannel),
        published: s.publishedAt ?? "",
      });
    }
  } catch {
    // No thread — new comment
  }

  const hasBackend = detectBackend(pluginConfig, pluginApi) !== null;

  if (hasBackend) {
    const proposedReply = await generateReply({
      comment,
      video: videoInfo,
      thread,
      identityName,
      config: pluginConfig,
      api: pluginApi,
      logger: log,
    });

    return { commentId, proposedReply, prompt: null, identity: identityName };
  }

  // No backend — return the built prompt so the agent can generate itself
  const identityText = await loadIdentity(identityName);
  const isThread = thread.length > 0;
  let prompt: string;
  if (isThread) {
    const threadText = formatThreadForPrompt(comment, thread);
    const replyToAuthor = getReplyToAuthor(comment, thread);
    prompt = buildThreadReplyPrompt(identityText, videoInfo, threadText, replyToAuthor);
  } else {
    prompt = buildNewCommentPrompt(identityText, videoInfo, comment.text);
  }

  return { commentId, proposedReply: null, prompt, identity: identityName };
}

// ============================================================
// Handler: reply (post reply to comment)
// ============================================================

async function handleReply(params: Record<string, unknown>): Promise<{
  commentId: string;
  text: string;
  success: boolean;
}> {
  await ensureInitialized();
  const log = pluginApi.logger;

  const commentId = params.commentId as string;
  const text = params.text as string;

  if (!commentId || !text) {
    throw new Error("commentId and text are required");
  }

  log.info(`reply: posting to ${commentId}`);

  const success = await postReply(youtube!, commentId, text, log);
  if (success) {
    await markReplied(getStatePath(), repliedSet, commentId);
  }

  return { commentId, text, success };
}

// ============================================================
// Handler: list (list comments for a video)
// ============================================================

async function handleCommentsList(params: Record<string, unknown>): Promise<CommentListResult> {
  await ensureInitialized();

  const videoId = params.videoId as string;
  if (!videoId) {
    throw new Error("videoId is required for list action");
  }

  return listComments(youtube!, videoId, {
    maxResults: params.limit as number | undefined,
    pageToken: params.pageToken as string | undefined,
    order: params.order as "time" | "relevance" | undefined,
    maxCommentAgeDays: params.maxCommentAgeDays as number | undefined,
    minCommentLength: params.minCommentLength as number | undefined,
    searchQuery: params.searchQuery as string | undefined,
  }, pluginApi.logger);
}

// ============================================================
// Handler: get (get single comment with thread)
// ============================================================

async function handleCommentsGet(params: Record<string, unknown>): Promise<{
  comment: CommentDetail;
  thread: ThreadReply[];
  videoTitle: string;
  videoDescription: string;
}> {
  await ensureInitialized();

  const commentId = params.commentId as string;
  if (!commentId) {
    throw new Error("commentId is required for get action");
  }

  return getComment(youtube!, commentId, replyAsChannelId!, pluginConfig.channelId, pluginApi.logger);
}

// ============================================================
// Handler: delete
// ============================================================

async function handleCommentsDelete(params: Record<string, unknown>): Promise<DeleteResult> {
  await ensureInitialized();

  const commentId = params.commentId as string;
  if (!commentId) {
    throw new Error("commentId is required for delete action");
  }

  const success = await deleteComment(youtube!, commentId, pluginApi.logger);
  return {
    commentId,
    success,
    message: success ? "Comment deleted" : "Failed to delete comment",
  };
}

// ============================================================
// Handler: moderate
// ============================================================

async function handleCommentsModerate(params: Record<string, unknown>): Promise<ModerateResult> {
  await ensureInitialized();

  const commentId = params.commentId as string;
  const moderationStatus = params.moderationStatus as ModerationStatus;
  const banAuthor = params.banAuthor as boolean | undefined;

  if (!commentId || !moderationStatus) {
    throw new Error("commentId and moderationStatus are required for moderate action");
  }

  const success = await setModerationStatus(
    youtube!, commentId, moderationStatus, banAuthor ?? false, pluginApi.logger,
  );

  return {
    commentId,
    moderationStatus,
    success,
    message: success
      ? `Comment moderation status set to ${moderationStatus}`
      : "Failed to moderate comment",
  };
}

// ============================================================
// Handler: channel status
// ============================================================

async function handleChannelStatus(): Promise<{
  channelId: string;
  channelIdentity: string;
  repliedTotal: number;
  lastScanTime: string | null;
  availableIdentities: string[];
  config: Record<string, unknown>;
}> {
  const identities = await listIdentities();

  return {
    channelId: pluginConfig.channelId,
    channelIdentity: pluginConfig.channelIdentity,
    repliedTotal: repliedSet.size,
    lastScanTime,
    availableIdentities: identities,
    config: {
      maxRecentVideos: pluginConfig.maxRecentVideos,
      maxCommentsPerVideo: pluginConfig.maxCommentsPerVideo,
      maxCommentAgeDays: pluginConfig.maxCommentAgeDays,
      minCommentLength: pluginConfig.minCommentLength,
      replyDelayMin: pluginConfig.replyDelayMin,
      replyDelayMax: pluginConfig.replyDelayMax,
      pollIntervalMinutes: pluginConfig.pollIntervalMinutes,
      geminiBackend: !!pluginConfig.geminiApiKey,
    },
  };
}

// ============================================================
// Handler: channel info
// ============================================================

async function handleChannelInfo(): Promise<ChannelInfo> {
  await ensureInitialized();
  return getChannelInfo(youtube!, pluginConfig.channelId, pluginApi.logger);
}

// ============================================================
// Handler: channel videos (list recent videos)
// ============================================================

async function handleChannelVideos(params: Record<string, unknown>): Promise<{
  channelId: string;
  videos: { id: string; title: string; description: string; pendingComments: number }[];
}> {
  await ensureInitialized();
  const log = pluginApi.logger;
  const maxVideos = (params.maxVideos as number) ?? pluginConfig.maxRecentVideos;

  let allVideos: Video[];
  if (pluginConfig.videoIds && pluginConfig.videoIds.length > 0) {
    allVideos = await Promise.all(pluginConfig.videoIds.map((id) => getVideoInfo(youtube!, id)));
  } else {
    allVideos = await getChannelVideos(youtube!, pluginConfig.channelId, maxVideos, log);
  }

  // For each video, count pending (unanswered) comments
  const videosWithPending: { id: string; title: string; description: string; pendingComments: number }[] = [];
  for (const video of allVideos) {
    const tasks = await scanVideoForTasks(youtube!, video, {
      config: pluginConfig,
      replyAsChannelId: replyAsChannelId!,
      repliedSet,
    }, log);

    if (tasks.length > 0) {
      videosWithPending.push({
        id: video.id,
        title: video.title,
        description: video.description,
        pendingComments: tasks.length,
      });
    }
  }

  return { channelId: pluginConfig.channelId, videos: videosWithPending };
}

// ============================================================
// Action routers
// ============================================================

async function routeCommentsAction(params: Record<string, unknown>): Promise<ToolResult> {
  const action = params.action as CommentsAction;
  switch (action) {
    case "list":
      return toolResult(await handleCommentsList(params));
    case "get":
      return toolResult(await handleCommentsGet(params));
    case "reply":
      return toolResult(await handleReply(params));
    case "delete":
      return toolResult(await handleCommentsDelete(params));
    case "moderate":
      return toolResult(await handleCommentsModerate(params));
    case "review":
      return toolResult(await handleReview(params));
    case "generate":
      return toolResult(await handleGenerate(params));
    default:
      throw new Error(`Unknown comments action: ${action}`);
  }
}

async function routeChannelAction(params: Record<string, unknown>): Promise<ToolResult> {
  const action = params.action as ChannelAction;
  switch (action) {
    case "status":
      return toolResult(await handleChannelStatus());
    case "info":
      return toolResult(await handleChannelInfo());
    case "videos":
      return toolResult(await handleChannelVideos(params));
    default:
      throw new Error(`Unknown channel action: ${action}`);
  }
}

// ============================================================
// /yt slash command
// ============================================================

async function handleYtCommand(ctx: { args?: string }): Promise<{ text: string }> {
  const args = (ctx.args ?? "").trim();

  if (args === "help") {
    return {
      text:
        `YouTube Comments Plugin\n` +
        `\n` +
        `Commands:\n` +
        `  /yt                              — channel status & config\n` +
        `  /yt reply [dry|auto]             — review/reply to comments (shows video picker first)\n` +
        `  /yt videos                       — list recent channel videos\n` +
        `  /yt list <videoId>               — list comments for a video\n` +
        `  /yt get <commentId>              — get comment with thread\n` +
        `  /yt delete <commentId>           — delete a comment\n` +
        `  /yt moderate <commentId> <status> — moderate (published|heldForReview|rejected)\n` +
        `  /yt info                         — channel info with stats\n` +
        `  /yt identities                   — list available personas\n` +
        `  /yt help                         — this message\n` +
        `\n` +
        `Options (for /yt reply):\n` +
        `  as <identity>    — use a specific persona (e.g. /yt reply as openprophet)\n` +
        `  limit <N>        — process at most N comments (e.g. /yt reply limit 5)\n` +
        `\n` +
        `Examples:\n` +
        `  /yt reply as volkova limit 10\n` +
        `  /yt reply dry as openprophet\n` +
        `  /yt reply auto limit 3\n` +
        `  /yt list dQw4w9WgXcQ\n` +
        `  /yt moderate UgxABC123 rejected`,
    };
  }

  // Parse "as <identity>" and "limit <N>" options from args
  const identityMatch = args.match(/\bas\s+(\w+)/);
  const limitMatch = args.match(/\blimit\s+(\d+)/);
  const scanIdentity = identityMatch?.[1];
  const scanLimit = limitMatch ? parseInt(limitMatch[1], 10) : undefined;
  // Strip options to get the bare subcommand
  const subcommand = args.replace(/\bas\s+\w+/, "").replace(/\blimit\s+\d+/, "").trim();

  // --- /yt reply [dry|auto] ---
  if (subcommand === "reply" || subcommand === "reply dry" || subcommand === "reply auto") {
    let mode: ScanMode = "interactive";
    let modeLabel = "Интерактивный режим";
    if (subcommand === "reply dry") {
      mode = "dry-run";
      modeLabel = "Превью (dry-run)";
    } else if (subcommand === "reply auto") {
      mode = "auto";
      modeLabel = "Авторежим";
    }
    const activeIdentity = scanIdentity ?? pluginConfig.channelIdentity;

    try {
      await ensureInitialized();
      const replyAccount = replyAsChannelId ?? "?";

      const { videos } = await handleChannelVideos({});
      const lines: string[] = [
        `${modeLabel}`,
        `Канал: ${pluginConfig.channelId}`,
        `Аккаунт: ${replyAccount}`,
        `Персона: ${activeIdentity}`,
        ``,
      ];

      if (videos.length === 0) {
        lines.push("Нет видео с неотвеченными комментариями.");
      } else {
        lines.push("Видео с неотвеченными комментариями:");
        videos.forEach((v, i) => {
          lines.push(`${i + 1}. ${v.title} — ${v.pendingComments} комм. (${v.id})`);
        });
        lines.push("");
        lines.push('Выбери номер или "все".');
      }

      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}\n\nОткрой ссылку, авторизуйся и вставь код.` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt videos ---
  if (subcommand === "videos") {
    try {
      await ensureInitialized();
      const { videos } = await handleChannelVideos({});
      if (videos.length === 0) {
        return { text: "Нет видео с неотвеченными комментариями." };
      }
      const lines = ["Видео с неотвеченными комментариями:"];
      videos.forEach((v, i) => {
        lines.push(`${i + 1}. ${v.title} — ${v.pendingComments} комм. (${v.id})`);
      });
      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt list <videoId> ---
  if (subcommand.startsWith("list")) {
    const videoId = subcommand.replace("list", "").trim();
    if (!videoId) {
      return { text: "Использование: /yt list <videoId>" };
    }
    try {
      await ensureInitialized();
      const result = await handleCommentsList({ videoId });
      if (result.comments.length === 0) {
        return { text: `Нет комментариев для видео "${result.videoTitle}".` };
      }
      const lines = [`Комментарии к "${result.videoTitle}" (${result.comments.length}):`];
      for (const c of result.comments) {
        lines.push(`\n@${c.author} (${c.published}):`);
        lines.push(c.text);
        if (c.replyCount > 0) lines.push(`  [${c.replyCount} ответов]`);
        lines.push(`  ID: ${c.id}`);
      }
      if (result.nextPageToken) {
        lines.push(`\nЕсть ещё комментарии (pageToken: ${result.nextPageToken})`);
      }
      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt get <commentId> ---
  if (subcommand.startsWith("get")) {
    const commentId = subcommand.replace("get", "").trim();
    if (!commentId) {
      return { text: "Использование: /yt get <commentId>" };
    }
    try {
      await ensureInitialized();
      const result = await handleCommentsGet({ commentId });
      const lines = [
        `Видео: ${result.videoTitle}`,
        `@${result.comment.author} (${result.comment.published}):`,
        result.comment.text,
        `Лайков: ${result.comment.likeCount}, ответов: ${result.comment.replyCount}`,
        `ID: ${result.comment.id}`,
      ];
      if (result.thread.length > 0) {
        lines.push(`\nТред (${result.thread.length} ответов):`);
        for (const r of result.thread) {
          const marker = r.isOurs ? " (вы)" : "";
          lines.push(`  @${r.author}${marker}: ${r.text}`);
        }
      }
      return { text: lines.join("\n") };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt delete <commentId> ---
  if (subcommand.startsWith("delete")) {
    const commentId = subcommand.replace("delete", "").trim();
    if (!commentId) {
      return { text: "Использование: /yt delete <commentId>" };
    }
    try {
      await ensureInitialized();
      const result = await handleCommentsDelete({ commentId });
      return { text: result.success ? `Комментарий ${commentId} удалён.` : `Не удалось удалить комментарий ${commentId}.` };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt moderate <commentId> <status> ---
  if (subcommand.startsWith("moderate")) {
    const parts = subcommand.replace("moderate", "").trim().split(/\s+/);
    const commentId = parts[0];
    const status = parts[1];
    if (!commentId || !status) {
      return { text: "Использование: /yt moderate <commentId> <published|heldForReview|rejected>" };
    }
    try {
      await ensureInitialized();
      const result = await handleCommentsModerate({ commentId, moderationStatus: status });
      return { text: result.success ? `Статус комментария ${commentId}: ${result.moderationStatus}` : `Не удалось изменить статус комментария ${commentId}.` };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt info ---
  if (subcommand === "info") {
    try {
      await ensureInitialized();
      const info = await handleChannelInfo();
      return {
        text:
          `Канал: ${info.title}\n` +
          `ID: ${info.id}\n` +
          `Подписчиков: ${info.subscriberCount}\n` +
          `Видео: ${info.videoCount}\n` +
          `Просмотров: ${info.viewCount}`,
      };
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        return { text: `Требуется авторизация YouTube.\n${err.authUrl}` };
      }
      return { text: `Ошибка: ${err}` };
    }
  }

  // --- /yt identities ---
  if (subcommand === "identities" || subcommand === "ids") {
    const ids = await listIdentities();
    return {
      text:
        `Available identities: ${ids.join(", ") || "(none)"}\n` +
        `Channel identity: ${pluginConfig.channelIdentity}`,
    };
  }

  // Default: status (bare /yt, /yt status, or unknown subcommand)
  const status = await handleChannelStatus();
  return {
    text:
      `YouTube Comments Plugin\n` +
      `Channel: ${status.channelId}\n` +
      `Replied total: ${status.repliedTotal}\n` +
      `Last scan: ${status.lastScanTime ?? "never"}\n` +
      `Identity: ${status.channelIdentity}\n` +
      `Available: ${status.availableIdentities.join(", ")}`,
  };
}

// ============================================================
// Background service
// ============================================================

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPollingService(): void {
  const intervalMs = pluginConfig.pollIntervalMinutes * 60 * 1000;
  if (intervalMs <= 0) {
    pluginApi.logger.info("Background polling disabled (pollIntervalMinutes = 0)");
    return;
  }

  pluginApi.logger.info(
    `Starting background polling service (every ${pluginConfig.pollIntervalMinutes} min)`,
  );

  pollTimer = setInterval(async () => {
    try {
      pluginApi.logger.info("Background poll: checking for new comments...");
      await ensureInitialized();

      // Quick dry-run scan
      const result = await handleReview({ mode: "dry-run", limit: 50 });
      const pendingCount = result.items.filter((i) => i.status === "pending").length;

      if (pendingCount > 0) {
        pluginApi.logger.info(`Background poll: found ${pendingCount} new comments`);
      } else {
        pluginApi.logger.debug("Background poll: no new comments");
      }
    } catch (err) {
      pluginApi.logger.error(`Background poll error: ${err}`);
    }
  }, intervalMs);
}

function stopPollingService(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    pluginApi.logger.info("Background polling service stopped");
  }
}

// ============================================================
// Plugin registration
// ============================================================

export default function register(api: OpenClawPluginApi): void {
  pluginApi = api;

  // api.config is the FULL OpenClaw gateway config.
  // Our plugin config lives at plugins.entries.openclaw-youtube.config
  const fullConfig = api.config as Record<string, unknown>;
  const pluginsSection = (fullConfig.plugins ?? {}) as Record<string, unknown>;
  const entriesSection = (pluginsSection.entries ?? {}) as Record<string, unknown>;
  const ourEntry = (entriesSection["openclaw-youtube"] ?? {}) as Record<string, unknown>;
  const ourConfig = (ourEntry.config ?? {}) as Record<string, unknown>;

  pluginConfig = resolveConfig(ourConfig);

  api.logger.info("YouTube Comments plugin loading...");

  // --- Tool: youtube_comments ---
  api.registerTool({
    name: "youtube_comments",
    description:
      "YouTube comment management. Actions: " +
      "list (list comments for a video), " +
      "get (get comment by ID with thread), " +
      "reply (post reply), " +
      "delete (delete comment), " +
      "moderate (set moderation status), " +
      "review (AI-powered scan & reply workflow), " +
      "generate (regenerate AI reply for a comment).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "reply", "delete", "moderate", "review", "generate"],
          description: "The action to perform",
        },
        // --- list params ---
        videoId: {
          type: "string",
          description: "Video ID (required for 'list'; optional for 'review' — limits review to a single video)",
        },
        pageToken: {
          type: "string",
          description: "Pagination token for 'list'",
        },
        order: {
          type: "string",
          enum: ["time", "relevance"],
          description: "Sort order for 'list' (default: time)",
        },
        searchQuery: {
          type: "string",
          description: "Text search within comments for 'list'",
        },
        maxCommentAgeDays: {
          type: "number",
          description: "Filter: max comment age in days for 'list'",
        },
        minCommentLength: {
          type: "number",
          description: "Filter: min comment length for 'list'",
        },
        // --- get/reply/delete/moderate/generate params ---
        commentId: {
          type: "string",
          description: "Comment ID (required for get, reply, delete, moderate, generate)",
        },
        // --- reply params ---
        text: {
          type: "string",
          description: "Reply text (required for 'reply')",
        },
        // --- moderate params ---
        moderationStatus: {
          type: "string",
          enum: ["published", "heldForReview", "rejected"],
          description: "Moderation status (required for 'moderate')",
        },
        banAuthor: {
          type: "boolean",
          description: "Ban the comment author (optional for 'moderate', default false)",
        },
        // --- review params ---
        mode: {
          type: "string",
          enum: ["dry-run", "interactive", "auto"],
          default: "interactive",
          description: "Operating mode for 'review'",
        },
        identity: {
          type: "string",
          description: "Identity/persona name for 'review' and 'generate'",
        },
        limit: {
          type: "number",
          description: "Max comments to process for 'review' and 'list'",
        },
        maxVideos: {
          type: "number",
          description: "Max recent videos for 'review'",
        },
        maxComments: {
          type: "number",
          description: "Max comments per video for 'review'",
        },
      },
      required: ["action"],
    },
    async execute(_id, params) {
      return withAuthHandling(() => routeCommentsAction(params));
    },
  });

  // --- Tool: youtube_channel ---
  api.registerTool({
    name: "youtube_channel",
    description:
      "YouTube channel operations. Actions: " +
      "status (plugin status, config, identities), " +
      "info (channel info with subscriber/video/view stats), " +
      "videos (list recent channel videos).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "info", "videos"],
          description: "The action to perform",
        },
        maxVideos: {
          type: "number",
          description: "Max videos to return for 'videos' action (default: from config)",
        },
      },
      required: ["action"],
    },
    async execute(_id, params) {
      return withAuthHandling(() => routeChannelAction(params));
    },
  });

  // --- Tool: youtube_auth ---
  api.registerTool({
    name: "youtube_auth",
    description:
      "Complete YouTube OAuth authorization. " +
      "Use when the user pastes an authorization code after clicking the auth link. " +
      "The code is shown by Google after the user grants access.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The authorization code from Google (pasted by the user after granting access)",
        },
      },
      required: ["code"],
    },
    async execute(_id, params) {
      const result = await handleYoutubeAuth(params);
      return toolResult(result);
    },
  });

  // --- Slash command: /yt ---
  api.registerCommand({
    name: "yt",
    description: "YouTube comments — reply, list, moderate, info. Try /yt help",
    acceptsArgs: true,
    handler: handleYtCommand,
  });

  // --- Background service ---
  api.registerService({
    id: "openclaw-youtube-poll",
    start: startPollingService,
    stop: stopPollingService,
  });

  api.logger.info(
    `YouTube Comments plugin loaded. Channel: ${pluginConfig.channelId}, identity: ${pluginConfig.channelIdentity}`,
  );
}

// ============================================================
// Auth handler (kept separate — special tool)
// ============================================================

async function handleYoutubeAuth(params: Record<string, unknown>): Promise<{
  success: boolean;
  message: string;
}> {
  const log = pluginApi.logger;
  const code = (params.code as string ?? "").trim();

  if (!code) {
    throw new Error("Authorization code is required");
  }

  const credPath = pluginConfig.oauthCredentialsPath;
  if (!credPath) {
    throw new Error("oauthCredentialsPath is not configured");
  }

  try {
    youtube = await completeOAuth(credPath, getTokenPath(pluginConfig), code, log);
    replyAsChannelId = await getAuthenticatedChannelId(youtube);
    repliedSet = await loadState(getStatePath());

    return {
      success: true,
      message: `Authorized successfully! Channel: ${replyAsChannelId ?? "unknown"}. You can now manage comments.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Authorization failed: ${err}. Please try again.`,
    };
  }
}

// ============================================================
// Utility
// ============================================================

/**
 * Wrap a tool handler to catch AuthRequiredError and return
 * the auth URL as a friendly message instead of an error.
 */
async function withAuthHandling(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return toolResult({
        authRequired: true,
        message: err.message,
        authUrl: err.authUrl,
      });
    }
    throw err;
  }
}

/** Wrap any JSON-serializable value into MCP-style tool result */
function toolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
