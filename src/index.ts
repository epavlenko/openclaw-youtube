/**
 * OpenClaw YouTube Comments Plugin — entry point.
 *
 * Registers:
 *   - 4 agent tools: youtube_scan, youtube_generate, youtube_reply, youtube_status
 *   - /yt slash command (no AI tokens)
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
} from "./types.js";
import { resolveConfig } from "./types.js";
import { getYouTubeService, getAuthenticatedChannelId, AuthRequiredError, completeOAuth } from "./auth.js";
import { getChannelVideos, getVideoInfo, scanVideoForTasks, postReply } from "./youtube.js";
import { loadState, saveState, markReplied } from "./state.js";
import { loadIdentity, listIdentities, buildNewCommentPrompt, buildThreadReplyPrompt, formatThreadForPrompt } from "./identities.js";
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
// Tool: youtube_scan
// ============================================================

async function handleYoutubeScan(params: Record<string, unknown>): Promise<ScanResult> {
  await ensureInitialized();
  const log = pluginApi.logger;

  const mode = (params.mode as ScanMode) ?? "interactive";
  const identityName = (params.identity as string) ?? pluginConfig.defaultIdentity;
  const limit = params.limit as number | undefined;
  const maxVideos = (params.maxVideos as number) ?? pluginConfig.maxRecentVideos;
  const maxComments = (params.maxComments as number) ?? pluginConfig.maxCommentsPerVideo;

  log.info(`youtube_scan: mode=${mode}, identity=${identityName}, limit=${limit ?? "none"}`);

  // Get videos to check
  let videos: Video[];
  if (pluginConfig.videoIds && pluginConfig.videoIds.length > 0) {
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
// Tool: youtube_generate
// ============================================================

async function handleYoutubeGenerate(params: Record<string, unknown>): Promise<{
  commentId: string;
  proposedReply: string | null;
  prompt: string | null;
  identity: string;
}> {
  await ensureInitialized();
  const log = pluginApi.logger;

  const commentId = params.commentId as string;
  const identityName = (params.identity as string) ?? pluginConfig.defaultIdentity;

  if (!commentId) {
    throw new Error("commentId is required");
  }

  log.info(`youtube_generate: commentId=${commentId}, identity=${identityName}`);

  // We need to fetch the comment and its context to generate a reply
  // This is used for regeneration — fetch thread context fresh

  // Fetch the comment thread to get video context
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
    // This comment is itself a reply — fetch the parent thread
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
    prompt = buildThreadReplyPrompt(identityText, videoInfo, threadText);
  } else {
    prompt = buildNewCommentPrompt(identityText, videoInfo, comment.text);
  }

  return { commentId, proposedReply: null, prompt, identity: identityName };
}

// ============================================================
// Tool: youtube_reply
// ============================================================

async function handleYoutubeReply(params: Record<string, unknown>): Promise<{
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

  log.info(`youtube_reply: posting to ${commentId}`);

  const success = await postReply(youtube!, commentId, text, log);
  if (success) {
    await markReplied(getStatePath(), repliedSet, commentId);
  }

  return { commentId, text, success };
}

// ============================================================
// Tool: youtube_status
// ============================================================

async function handleYoutubeStatus(): Promise<{
  channelId: string;
  repliedTotal: number;
  lastScanTime: string | null;
  availableIdentities: string[];
  currentIdentity: string;
  config: Record<string, unknown>;
}> {
  const identities = await listIdentities();

  return {
    channelId: pluginConfig.channelId,
    repliedTotal: repliedSet.size,
    lastScanTime,
    availableIdentities: identities,
    currentIdentity: pluginConfig.defaultIdentity,
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
// Tool: youtube_auth
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
      message: `Authorized successfully! Channel: ${replyAsChannelId ?? "unknown"}. You can now scan comments.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Authorization failed: ${err}. Please try again.`,
    };
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
        `  /yt              — channel status & config\n` +
        `  /yt scan         — scan & review comments one by one\n` +
        `  /yt preview      — preview all replies without posting\n` +
        `  /yt auto         — generate & post all replies automatically\n` +
        `  /yt identities   — list available personas\n` +
        `  /yt help         — this message\n` +
        `\n` +
        `Options:\n` +
        `  as <identity>    — use a specific persona (e.g. /yt scan as openprophet)\n` +
        `  limit <N>        — process at most N comments (e.g. /yt preview limit 5)\n` +
        `\n` +
        `Examples:\n` +
        `  /yt scan as volkova limit 10\n` +
        `  /yt preview as openprophet\n` +
        `  /yt auto limit 3`,
    };
  }

  // Parse "as <identity>" and "limit <N>" options from args
  const identityMatch = args.match(/\bas\s+(\w+)/);
  const limitMatch = args.match(/\blimit\s+(\d+)/);
  const scanIdentity = identityMatch?.[1];
  const scanLimit = limitMatch ? parseInt(limitMatch[1], 10) : undefined;
  // Strip options to get the bare subcommand
  const subcommand = args.replace(/\bas\s+\w+/, "").replace(/\blimit\s+\d+/, "").trim();

  if (subcommand === "scan" || subcommand === "check") {
    try {
      await ensureInitialized();
      const scanParams: Record<string, unknown> = { mode: "interactive" };
      if (scanIdentity) scanParams.identity = scanIdentity;
      if (scanLimit) scanParams.limit = scanLimit;
      const result = await handleYoutubeScan(scanParams);
      const pendingCount = result.items.filter((i) => i.status === "pending").length;
      const skippedCount = result.items.filter((i) => i.status === "skipped").length;
      if (pendingCount === 0) {
        return { text: `No new comments found. (scanned ${result.found} total, ${skippedCount} skipped)` };
      }
      // Format each pending item for the agent to present
      const needsGeneration = result.items.some((i) => i.status === "pending" && !i.proposedReply);
      const lines: string[] = [];
      lines.push(...formatScanItems(result.items));
      lines.unshift(`Found ${pendingCount} comments to review (${skippedCount} skipped)\n`);
      if (needsGeneration) {
        lines.push(`---`);
        lines.push(`**Identity prompt for reply generation:**`);
        lines.push(result.identityPrompt);
        lines.push(``);
        lines.push(`Generate a reply for each comment above where Reply is [reply-text]. Use the identity prompt, comment text, and video context. Reply in the same language as the comment. Present each reply and ask the user to approve or skip.`);
      }
      return { text: lines.join("\n") };
    } catch (err) {
      return { text: `Error: ${err}` };
    }
  }

  if (subcommand === "preview" || subcommand === "dry-run") {
    try {
      await ensureInitialized();
      const scanParams: Record<string, unknown> = { mode: "dry-run" };
      if (scanIdentity) scanParams.identity = scanIdentity;
      if (scanLimit) scanParams.limit = scanLimit;
      const result = await handleYoutubeScan(scanParams);
      const pendingCount = result.items.filter((i) => i.status === "pending").length;
      const skippedCount = result.items.filter((i) => i.status === "skipped").length;
      if (pendingCount === 0) {
        return { text: `No new comments found. (${skippedCount} skipped)` };
      }
      const needsGeneration = result.items.some((i) => i.status === "pending" && !i.proposedReply);
      const lines: string[] = [];
      lines.push(...formatScanItems(result.items));
      lines.unshift(`Preview: ${pendingCount} comments (${skippedCount} skipped)\n`);
      lines.push(`(dry-run — nothing posted)`);
      // When no backend generated replies, give the agent identity prompt + instructions
      if (needsGeneration) {
        lines.push(``);
        lines.push(`---`);
        lines.push(`**Identity prompt for reply generation:**`);
        lines.push(result.identityPrompt);
        lines.push(``);
        lines.push(`Generate a reply for each comment above where Reply is [reply-text]. Use the identity prompt, comment text, and video context. Reply in the same language as the comment. This is a preview — do NOT post anything.`);
      }
      return { text: lines.join("\n") };
    } catch (err) {
      return { text: `Error: ${err}` };
    }
  }

  if (subcommand === "auto") {
    try {
      await ensureInitialized();
      const scanParams: Record<string, unknown> = { mode: "auto" };
      if (scanIdentity) scanParams.identity = scanIdentity;
      if (scanLimit) scanParams.limit = scanLimit;
      const result = await handleYoutubeScan(scanParams);
      const postedCount = result.items.filter((i) => i.status === "posted").length;
      const pendingCount = result.items.filter((i) => i.status === "pending").length;
      const skippedCount = result.items.filter((i) => i.status === "skipped").length;
      const lines: string[] = [];
      if (postedCount > 0) {
        lines.push(`Auto-posted ${postedCount} replies.`);
      }
      if (pendingCount > 0) {
        lines.push(`${pendingCount} replies need agent to generate & post.`);
      }
      if (skippedCount > 0) {
        lines.push(`${skippedCount} skipped.`);
      }
      if (lines.length === 0) {
        lines.push(`No new comments found.`);
      }
      return { text: lines.join("\n") };
    } catch (err) {
      return { text: `Error: ${err}` };
    }
  }

  if (subcommand === "identities" || subcommand === "ids") {
    const ids = await listIdentities();
    return {
      text:
        `Available identities: ${ids.join(", ") || "(none)"}\n` +
        `Current default: ${pluginConfig.defaultIdentity}`,
    };
  }

  // Default: status (bare /yt, /yt status, or unknown subcommand)
  const status = await handleYoutubeStatus();
  return {
    text:
      `YouTube Comments Plugin\n` +
      `Channel: ${status.channelId}\n` +
      `Replied total: ${status.repliedTotal}\n` +
      `Last scan: ${status.lastScanTime ?? "never"}\n` +
      `Identity: ${status.currentIdentity}\n` +
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
      const result = await handleYoutubeScan({ mode: "dry-run", limit: 50 });
      const pendingCount = result.items.filter((i) => i.status === "pending").length;

      if (pendingCount > 0) {
        pluginApi.logger.info(`Background poll: found ${pendingCount} new comments`);
        // The agent will pick this up and notify the user via Telegram
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

  // --- Tool: youtube_scan ---
  api.registerTool({
    name: "youtube_scan",
    description:
      "Scan YouTube channel for new comments, generate AI replies. " +
      "Supports modes: 'dry-run' (preview only), 'interactive' (show one by one for approval), 'auto' (post all automatically). " +
      "Returns structured JSON with comments and proposed replies.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["dry-run", "interactive", "auto"],
          default: "interactive",
          description: "Operating mode: dry-run (preview), interactive (approve each), auto (post all)",
        },
        identity: {
          type: "string",
          description: "Identity/persona name for reply generation (e.g. 'volkova', 'openprophet')",
        },
        limit: {
          type: "number",
          description: "Maximum number of comments to process",
        },
        maxVideos: {
          type: "number",
          description: "Maximum number of recent videos to scan",
        },
        maxComments: {
          type: "number",
          description: "Maximum comments per video",
        },
      },
    },
    async execute(_id, params) {
      return withAuthHandling(async () => {
        const result = await handleYoutubeScan(params);
        return toolResult(result);
      });
    },
  });

  // --- Tool: youtube_generate ---
  api.registerTool({
    name: "youtube_generate",
    description:
      "Regenerate a reply for a specific YouTube comment. " +
      "Use when the user asks to regenerate, or to try a different identity.",
    parameters: {
      type: "object",
      properties: {
        commentId: {
          type: "string",
          description: "YouTube comment ID to generate a reply for",
        },
        identity: {
          type: "string",
          description: "Identity/persona name (optional, uses default if not set)",
        },
      },
      required: ["commentId"],
    },
    async execute(_id, params) {
      return withAuthHandling(async () => {
        const result = await handleYoutubeGenerate(params);
        return toolResult(result);
      });
    },
  });

  // --- Tool: youtube_reply ---
  api.registerTool({
    name: "youtube_reply",
    description:
      "Post a reply to a specific YouTube comment. " +
      "Use after the user approves a reply in interactive mode, or to post a custom reply.",
    parameters: {
      type: "object",
      properties: {
        commentId: {
          type: "string",
          description: "YouTube comment ID to reply to",
        },
        text: {
          type: "string",
          description: "The reply text to post",
        },
      },
      required: ["commentId", "text"],
    },
    async execute(_id, params) {
      return withAuthHandling(async () => {
        const result = await handleYoutubeReply(params);
        return toolResult(result);
      });
    },
  });

  // --- Tool: youtube_status ---
  api.registerTool({
    name: "youtube_status",
    description:
      "Get YouTube Comments plugin status: channel info, reply count, available identities, config.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const result = await handleYoutubeStatus();
      return toolResult(result);
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
    description: "YouTube comments — scan, preview, auto-reply, identities. Try /yt help",
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
    `YouTube Comments plugin loaded. Channel: ${pluginConfig.channelId}, identity: ${pluginConfig.defaultIdentity}`,
  );
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

/** Format ISO date as "YYYY.MM.DD HH:mm" */
function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SEPARATOR_THREAD = "================================================================";
const SEPARATOR_COMMENT = "----------------------------------------------------------------";

/** Format scan items for /yt scan and /yt preview output */
function formatScanItems(items: ScanItem[]): string[] {
  const lines: string[] = [];
  // Group items by video
  const byVideo = new Map<string, ScanItem[]>();
  for (const item of items) {
    if (item.status === "skipped") continue;
    const key = item.videoId;
    if (!byVideo.has(key)) byVideo.set(key, []);
    byVideo.get(key)!.push(item);
  }

  let firstVideo = true;
  for (const [, videoItems] of byVideo) {
    if (!firstVideo) {
      lines.push(``);
    }
    // Video title once per group
    lines.push(`🎬 ${videoItems[0].videoTitle}`);

    for (const item of videoItems) {
      lines.push(SEPARATOR_THREAD);
      // Top-level comment
      lines.push(`${formatDate(item.published)} / ${item.author}: ${item.text}`);
      // Thread replies
      if (item.isThread && item.thread.length > 0) {
        for (const r of item.thread) {
          lines.push(SEPARATOR_COMMENT);
          const marker = r.isOurs ? " (you)" : "";
          const date = r.published ? `${formatDate(r.published)} / ` : "";
          lines.push(`${date}${r.author}${marker}: ${r.text}`);
        }
      }
      // Reply
      lines.push(SEPARATOR_THREAD);
      if (item.proposedReply) {
        lines.push(`Reply: ${item.proposedReply}`);
      } else {
        lines.push(`Reply: [reply-text]`);
      }
      lines.push(SEPARATOR_THREAD);
      // Separator between threads: two blank lines before next thread
      lines.push(``);
      lines.push(``);
    }
    firstVideo = false;
  }

  return lines;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
