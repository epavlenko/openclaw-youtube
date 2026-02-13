/**
 * Tests for src/youtube.ts — YouTube API wrapper.
 *
 * These test the pure logic functions (formatThreadForPrompt),
 * and verify the filtering logic with mock data.
 */

import { describe, it, expect } from "vitest";
import { formatThreadForPrompt } from "../src/youtube.js";
import type { Comment, ThreadReply } from "../src/types.js";

describe("youtube", () => {
  describe("formatThreadForPrompt", () => {
    const comment: Comment = {
      id: "Ugx123",
      text: "Love this set!",
      author: "FanUser",
      published: "2026-02-10T08:00:00Z",
      replyCount: 2,
    };

    it("formats a standalone comment (no thread)", () => {
      const result = formatThreadForPrompt(comment, []);
      expect(result).toBe("@FanUser: Love this set!");
    });

    it("formats a comment with replies", () => {
      const thread: ThreadReply[] = [
        { author: "VOLKOVA", text: "Thank you!", isOurs: true },
        { author: "FanUser", text: "Can't wait for the next one", isOurs: false },
      ];

      const result = formatThreadForPrompt(comment, thread);
      expect(result).toContain("@FanUser: Love this set!");
      expect(result).toContain("@VOLKOVA (you): Thank you!");
      expect(result).toContain("@FanUser: Can't wait for the next one");
    });

    it("indents thread replies with two spaces", () => {
      const thread: ThreadReply[] = [
        { author: "OtherUser", text: "Amazing!", isOurs: false },
      ];

      const lines = formatThreadForPrompt(comment, thread).split("\n");
      expect(lines[0]).not.toMatch(/^\s/); // Top-level is not indented
      expect(lines[1]).toMatch(/^  /); // Reply is indented
    });
  });
});
