/**
 * State management — track which comments we've replied to.
 *
 * Port of main.py:71-84.
 * Format is JSON-compatible with the Python bot's replied_comments.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { StateData } from "./types.js";

const DEFAULT_STATE: StateData = {
  replied: [],
  updatedAt: new Date().toISOString(),
};

/**
 * Load set of comment IDs we've already replied to.
 * Port of main.py:71-77 (load_state).
 */
export async function loadState(filePath: string): Promise<Set<string>> {
  if (!existsSync(filePath)) {
    return new Set();
  }

  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as { replied?: string[]; updated_at?: string };
    return new Set(data.replied ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Persist replied comment IDs.
 * Port of main.py:80-84 (save_state).
 *
 * Output format matches the Python bot's format:
 *   { "replied": [...sorted IDs...], "updated_at": "ISO date" }
 */
export async function saveState(
  filePath: string,
  replied: Set<string>,
): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const data = {
    replied: [...replied].sort(),
    updated_at: new Date().toISOString(),
  };

  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Add a comment ID to the replied set and save.
 */
export async function markReplied(
  filePath: string,
  replied: Set<string>,
  commentId: string,
): Promise<void> {
  replied.add(commentId);
  await saveState(filePath, replied);
}

/**
 * Get the number of replied comments.
 */
export function getRepliedCount(replied: Set<string>): number {
  return replied.size;
}
