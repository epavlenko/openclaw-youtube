/**
 * Tests for src/state.ts — replied comments state management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadState, saveState, markReplied, getRepliedCount } from "../src/state.js";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "openclaw-youtube-test-state");
const TEST_FILE = join(TEST_DIR, "replied_comments.json");

describe("state", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  describe("loadState", () => {
    it("returns empty set if file does not exist", async () => {
      const result = await loadState(join(TEST_DIR, "nonexistent.json"));
      expect(result).toEqual(new Set());
    });

    it("loads replied IDs from JSON file", async () => {
      const data = {
        replied: ["comment1", "comment2", "comment3"],
        updated_at: "2026-01-01T00:00:00.000Z",
      };
      await writeFile(TEST_FILE, JSON.stringify(data), "utf-8");

      const result = await loadState(TEST_FILE);
      expect(result).toEqual(new Set(["comment1", "comment2", "comment3"]));
      expect(result.size).toBe(3);
    });

    it("handles corrupted JSON gracefully", async () => {
      await writeFile(TEST_FILE, "not valid json{{{", "utf-8");
      const result = await loadState(TEST_FILE);
      expect(result).toEqual(new Set());
    });

    it("handles JSON without replied field", async () => {
      await writeFile(TEST_FILE, JSON.stringify({ some: "other" }), "utf-8");
      const result = await loadState(TEST_FILE);
      expect(result).toEqual(new Set());
    });
  });

  describe("saveState", () => {
    it("creates file with sorted IDs and timestamp", async () => {
      const replied = new Set(["c3", "c1", "c2"]);
      await saveState(TEST_FILE, replied);

      const raw = await import("node:fs/promises").then((m) =>
        m.readFile(TEST_FILE, "utf-8"),
      );
      const data = JSON.parse(raw);

      expect(data.replied).toEqual(["c1", "c2", "c3"]); // sorted
      expect(data.updated_at).toBeTruthy();
      expect(new Date(data.updated_at).getTime()).toBeGreaterThan(0);
    });

    it("creates parent directories if they don't exist", async () => {
      const deepPath = join(TEST_DIR, "a", "b", "c", "state.json");
      await saveState(deepPath, new Set(["x"]));

      expect(existsSync(deepPath)).toBe(true);
    });

    it("overwrites existing file", async () => {
      await saveState(TEST_FILE, new Set(["old"]));
      await saveState(TEST_FILE, new Set(["new1", "new2"]));

      const raw = await import("node:fs/promises").then((m) =>
        m.readFile(TEST_FILE, "utf-8"),
      );
      const data = JSON.parse(raw);
      expect(data.replied).toEqual(["new1", "new2"]);
    });
  });

  describe("markReplied", () => {
    it("adds comment ID and saves", async () => {
      const replied = new Set(["existing"]);
      await markReplied(TEST_FILE, replied, "new_comment");

      expect(replied.has("new_comment")).toBe(true);
      expect(replied.size).toBe(2);

      // Verify it was persisted
      const loaded = await loadState(TEST_FILE);
      expect(loaded.has("new_comment")).toBe(true);
      expect(loaded.has("existing")).toBe(true);
    });
  });

  describe("getRepliedCount", () => {
    it("returns set size", () => {
      expect(getRepliedCount(new Set())).toBe(0);
      expect(getRepliedCount(new Set(["a", "b"]))).toBe(2);
    });
  });
});
