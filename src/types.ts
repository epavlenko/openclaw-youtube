/**
 * TypeScript interfaces for the OpenClaw YouTube Comments plugin.
 *
 * These mirror the data structures used in the Python youtube-auto-reply bot,
 * adapted for TypeScript and the OpenClaw plugin system.
 */

// ============================================================
// YouTube Data Types
// ============================================================

export interface Video {
  id: string;
  title: string;
  description: string;
}

export interface Comment {
  /** YouTube comment ID (e.g. "UgxABC123...") */
  id: string;
  /** Comment text (plain text) */
  text: string;
  /** Author display name */
  author: string;
  /** ISO 8601 publish date */
  published: string;
  /** Number of replies in the thread */
  replyCount: number;
}

export interface ThreadReply {
  /** Author display name */
  author: string;
  /** Reply text (plain text) */
  text: string;
  /** Whether this reply was posted by our channel */
  isOurs: boolean;
  /** ISO 8601 publish date */
  published: string;
}

// ============================================================
// Action Types for Grouped Tools
// ============================================================

export type CommentsAction = "list" | "get" | "reply" | "delete" | "moderate" | "review" | "generate";
export type ChannelAction = "status" | "info" | "videos";
export type ModerationStatus = "published" | "heldForReview" | "rejected";

// ============================================================
// Comment Detail Types (for list/get)
// ============================================================

/** Extended comment with full metadata — used by list/get actions */
export interface CommentDetail extends Comment {
  likeCount: number;
  videoId: string;
  authorChannelId: string;
  /** Parent comment ID if this is a reply */
  parentId?: string;
}

export interface CommentListResult {
  videoId: string;
  videoTitle: string;
  comments: CommentDetail[];
  totalResults: number;
  nextPageToken?: string;
}

export interface ChannelInfo {
  id: string;
  title: string;
  description: string;
  subscriberCount: string;
  videoCount: string;
  viewCount: string;
  thumbnailUrl: string;
}

export interface DeleteResult {
  commentId: string;
  success: boolean;
  message?: string;
}

export interface ModerateResult {
  commentId: string;
  moderationStatus: ModerationStatus;
  success: boolean;
  message?: string;
}

// ============================================================
// Scan & Reply Types
// ============================================================

export type ScanItemStatus = "pending" | "posted" | "skipped";

export interface ScanItem {
  commentId: string;
  author: string;
  text: string;
  videoTitle: string;
  videoDescription: string;
  videoId: string;
  published: string;
  isThread: boolean;
  thread: ThreadReply[];
  proposedReply: string | null;
  status: ScanItemStatus;
}

export type ScanMode = "dry-run" | "interactive" | "auto";

export interface ScanResult {
  mode: ScanMode;
  identity: string;
  identityPrompt: string;
  found: number;
  items: ScanItem[];
}

// ============================================================
// Plugin Config Types
// ============================================================

export interface PluginConfig {
  channelId: string;
  videoIds?: string[];
  maxRecentVideos: number;
  maxCommentsPerVideo: number;
  maxCommentAgeDays: number;
  minCommentLength: number;
  /** Identity bound to the channel owner — used as default for review/generate */
  channelIdentity: string;
  /** @deprecated Use channelIdentity instead */
  defaultIdentity: string;
  replyDelayMin: number;
  replyDelayMax: number;
  oauthCredentialsPath?: string;
  oauthTokenPath?: string;
  geminiApiKey?: string;
  geminiModel: string;
  pollIntervalMinutes: number;
}

/** Resolved config with all defaults applied */
export function resolveConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    channelId: (raw.channelId as string) ?? "",
    videoIds: (raw.videoIds as string[] | undefined),
    maxRecentVideos: (raw.maxRecentVideos as number) ?? 5,
    maxCommentsPerVideo: (raw.maxCommentsPerVideo as number) ?? 50,
    maxCommentAgeDays: (raw.maxCommentAgeDays as number) ?? 7,
    minCommentLength: (raw.minCommentLength as number) ?? 3,
    channelIdentity: (raw.channelIdentity as string) ?? (raw.defaultIdentity as string) ?? "volkova",
    defaultIdentity: (raw.defaultIdentity as string) ?? (raw.channelIdentity as string) ?? "volkova",
    replyDelayMin: (raw.replyDelayMin as number) ?? 10,
    replyDelayMax: (raw.replyDelayMax as number) ?? 60,
    oauthCredentialsPath: raw.oauthCredentialsPath as string | undefined,
    oauthTokenPath: raw.oauthTokenPath as string | undefined,
    geminiApiKey: raw.geminiApiKey as string | undefined,
    geminiModel: (raw.geminiModel as string) ?? "gemini-2.0-flash",
    pollIntervalMinutes: (raw.pollIntervalMinutes as number) ?? 120,
  };
}

// ============================================================
// State Types
// ============================================================

export interface StateData {
  replied: string[];
  updatedAt: string;
}

// ============================================================
// Reply Generator Types
// ============================================================

export type ReplyBackend = "openclaw" | "gemini";

export interface GenerateReplyParams {
  commentText: string;
  videoTitle: string;
  videoDescription: string;
  identityText: string;
  threadText?: string;
}

// ============================================================
// OpenClaw Plugin API Types (minimal, for type safety)
// ============================================================

/** Content block returned by tool execute() — MCP-style */
export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContentBlock[];
}

/** Minimal type for the OpenClaw plugin API passed to register() */
export interface OpenClawPluginApi {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  config: Record<string, unknown>;
  registerTool: (tool: AgentToolDef, opts?: { optional?: boolean }) => void;
  registerCommand: (cmd: CommandDef) => void;
  registerService: (svc: ServiceDef) => void;
  runtime?: {
    tts?: unknown;
    llm?: {
      generate: (params: { prompt: string; model?: string }) => Promise<{ text: string }>;
    };
  };
}

export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface CommandDef {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: CommandContext) => Promise<{ text: string }> | { text: string };
}

export interface CommandContext {
  senderId?: string;
  channel?: string;
  isAuthorizedSender?: boolean;
  args?: string;
  commandBody?: string;
  config?: Record<string, unknown>;
}

export interface ServiceDef {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}
