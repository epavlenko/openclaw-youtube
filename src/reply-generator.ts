/**
 * Reply generation with dual backend support.
 *
 * Backend A: OpenClaw connected model (default, when geminiApiKey is not set).
 *   Uses api.runtime.llm.generate() to call whatever model the user has configured.
 *
 * Backend B: Direct Gemini API (when geminiApiKey IS set).
 *   Exact reproduction of Python bot behavior using @google/generative-ai.
 *
 * Port of main.py:287-331 (generate_reply) + config.py prompt templates.
 */

import type { Video, Comment, ThreadReply, PluginConfig, OpenClawPluginApi, ReplyBackend } from "./types.js";
import { loadIdentity, buildNewCommentPrompt, buildThreadReplyPrompt, formatThreadForPrompt, getReplyToAuthor } from "./identities.js";

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

const defaultLogger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

// ============================================================
// Public interface
// ============================================================

export interface GenerateReplyOptions {
  comment: Comment;
  video: Video;
  thread: ThreadReply[];
  identityName: string;
  config: PluginConfig;
  api?: OpenClawPluginApi;
  logger?: Logger;
}

/**
 * Generate a reply for a comment. Supports both OpenClaw model and direct Gemini API.
 *
 * Returns the reply text, or null if the model decided to SKIP.
 * Port of main.py:287-331 (generate_reply).
 */
export async function generateReply(opts: GenerateReplyOptions): Promise<string | null> {
  const log = opts.logger ?? defaultLogger;

  // Load identity text
  const identityText = await loadIdentity(opts.identityName);

  // Determine if this is a thread reply or new comment
  const isThread = opts.thread.length > 0;

  // Build prompt
  let prompt: string;
  if (isThread) {
    const threadText = formatThreadForPrompt(opts.comment, opts.thread);
    const replyToAuthor = getReplyToAuthor(opts.comment, opts.thread);
    prompt = buildThreadReplyPrompt(identityText, opts.video, threadText, replyToAuthor);
  } else {
    prompt = buildNewCommentPrompt(identityText, opts.video, opts.comment.text);
  }

  // Choose backend
  const backend = detectBackend(opts.config, opts.api);
  if (!backend) {
    log.debug("No reply generation backend available — skipping plugin-side generation");
    return null;
  }
  log.debug(`Using ${backend} backend for reply generation`);

  let reply: string;
  try {
    if (backend === "gemini") {
      reply = await generateViaGemini(prompt, opts.config, log);
    } else {
      reply = await generateViaOpenClaw(prompt, opts.api!, log);
    }
  } catch (err) {
    log.error(`Reply generation error (${backend}): ${err}`);
    return null;
  }

  // Check if model wants to skip this comment
  if (reply.trim().toUpperCase() === "SKIP") {
    log.info(`Model returned SKIP for comment ${opts.comment.id}`);
    return null;
  }

  // Clean up: remove quotes if model wrapped the reply
  // Port of main.py:324-326
  reply = reply.trim();
  if (reply.startsWith('"') && reply.endsWith('"')) {
    reply = reply.slice(1, -1);
  }

  return reply;
}

/**
 * Regenerate a reply with a potentially different identity.
 * Convenience wrapper for the youtube_generate tool.
 */
export async function regenerateReply(
  comment: Comment,
  video: Video,
  thread: ThreadReply[],
  identityName: string,
  config: PluginConfig,
  api?: OpenClawPluginApi,
  logger?: Logger,
): Promise<string | null> {
  return generateReply({
    comment,
    video,
    thread,
    identityName,
    config,
    api,
    logger,
  });
}

// ============================================================
// Backend detection
// ============================================================

export function detectBackend(config: PluginConfig, api?: OpenClawPluginApi): ReplyBackend | null {
  // If Gemini API key is configured, use direct Gemini
  if (config.geminiApiKey) {
    return "gemini";
  }
  // Otherwise, use OpenClaw's connected model (if available)
  if (api?.runtime?.llm) {
    return "openclaw";
  }
  // No backend available — caller should handle this gracefully
  return null;
}

// ============================================================
// Backend A: OpenClaw model
// ============================================================

async function generateViaOpenClaw(
  prompt: string,
  api: OpenClawPluginApi,
  log: Logger,
): Promise<string> {
  if (!api.runtime?.llm) {
    throw new Error("OpenClaw LLM runtime not available");
  }

  log.debug("Generating reply via OpenClaw connected model...");
  const result = await api.runtime.llm.generate({ prompt });
  return result.text;
}

// ============================================================
// Backend B: Direct Gemini API
// ============================================================

async function generateViaGemini(
  prompt: string,
  config: PluginConfig,
  log: Logger,
): Promise<string> {
  if (!config.geminiApiKey) {
    throw new Error("Gemini API key not configured");
  }

  log.debug(`Generating reply via Gemini API (model: ${config.geminiModel})...`);

  // Dynamic import to avoid requiring the package when using OpenClaw backend
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: config.geminiModel });

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.text();

  return text;
}
