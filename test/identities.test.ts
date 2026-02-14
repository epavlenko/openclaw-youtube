/**
 * Tests for src/identities.ts — identity loading and prompt building.
 */

import { describe, it, expect } from "vitest";
import {
  buildNewCommentPrompt,
  buildThreadReplyPrompt,
  formatThreadForPrompt,
  PROMPT_NEW_COMMENT,
  PROMPT_THREAD_REPLY,
} from "../src/identities.js";
import type { Video, Comment, ThreadReply } from "../src/types.js";

const mockVideo: Video = {
  id: "test123",
  title: "Sunrise Set | Norway Fjords",
  description: "A melodic house DJ set filmed at the Norwegian fjords during golden hour. Featuring tracks by...",
};

const mockComment: Comment = {
  id: "Ugx_test_comment",
  text: "This set is absolutely magical! The Norway scenery is breathtaking.",
  author: "MusicLover42",
  published: "2026-02-12T10:00:00Z",
  replyCount: 0,
};

const mockIdentity = `You are Nastya from VOLKOVA. Keep replies short, warm, and natural.
Always match the commenter's language.`;

describe("identities", () => {
  describe("PROMPT_NEW_COMMENT", () => {
    it("contains all required placeholders", () => {
      expect(PROMPT_NEW_COMMENT).toContain("{identity}");
      expect(PROMPT_NEW_COMMENT).toContain("{video_title}");
      expect(PROMPT_NEW_COMMENT).toContain("{video_description}");
      expect(PROMPT_NEW_COMMENT).toContain("{comment_text}");
    });
  });

  describe("PROMPT_THREAD_REPLY", () => {
    it("contains all required placeholders", () => {
      expect(PROMPT_THREAD_REPLY).toContain("{identity}");
      expect(PROMPT_THREAD_REPLY).toContain("{video_title}");
      expect(PROMPT_THREAD_REPLY).toContain("{video_description}");
      expect(PROMPT_THREAD_REPLY).toContain("{thread_text}");
    });
  });

  describe("buildNewCommentPrompt", () => {
    it("replaces all placeholders correctly", () => {
      const prompt = buildNewCommentPrompt(mockIdentity, mockVideo, mockComment.text);

      expect(prompt).toContain(mockIdentity);
      expect(prompt).toContain(mockVideo.title);
      expect(prompt).toContain(mockComment.text);
      expect(prompt).not.toContain("{identity}");
      expect(prompt).not.toContain("{video_title}");
      expect(prompt).not.toContain("{video_description}");
      expect(prompt).not.toContain("{comment_text}");
    });

    it("truncates video description to 500 chars", () => {
      const longDesc = "A".repeat(1000);
      const video = { ...mockVideo, description: longDesc };
      const prompt = buildNewCommentPrompt(mockIdentity, video, mockComment.text);

      // The description in the prompt should be at most 500 chars
      expect(prompt).toContain("A".repeat(500));
      expect(prompt).not.toContain("A".repeat(501));
    });
  });

  describe("buildThreadReplyPrompt", () => {
    it("replaces all placeholders correctly", () => {
      const threadText = "@MusicLover42: Amazing set!\n  @VOLKOVA (you): Thank you!";
      const prompt = buildThreadReplyPrompt(mockIdentity, mockVideo, threadText);

      expect(prompt).toContain(mockIdentity);
      expect(prompt).toContain(mockVideo.title);
      expect(prompt).toContain(threadText);
      expect(prompt).not.toContain("{identity}");
      expect(prompt).not.toContain("{thread_text}");
    });
  });

  describe("formatThreadForPrompt", () => {
    it("formats a comment with no thread", () => {
      const result = formatThreadForPrompt(mockComment, []);
      expect(result).toBe("@MusicLover42: This set is absolutely magical! The Norway scenery is breathtaking.");
    });

    it("formats a comment with thread replies", () => {
      const thread: ThreadReply[] = [
        { author: "VOLKOVA", text: "Thank you so much!", isOurs: true, published: "2026-02-10T09:00:00Z" },
        { author: "MusicLover42", text: "When is the next one?", isOurs: false, published: "2026-02-10T10:00:00Z" },
      ];

      const result = formatThreadForPrompt(mockComment, thread);
      const lines = result.split("\n");

      expect(lines[0]).toBe("@MusicLover42: This set is absolutely magical! The Norway scenery is breathtaking.");
      expect(lines[1]).toBe("  @VOLKOVA (you): Thank you so much!");
      expect(lines[2]).toBe("  @MusicLover42: When is the next one?");
    });

    it("marks our replies with (you)", () => {
      const thread: ThreadReply[] = [
        { author: "SomeUser", text: "Nice!", isOurs: false, published: "2026-02-10T09:00:00Z" },
        { author: "VOLKOVA", text: "Thanks!", isOurs: true, published: "2026-02-10T10:00:00Z" },
      ];

      const result = formatThreadForPrompt(mockComment, thread);
      expect(result).toContain("(you)");
      expect(result).toContain("@VOLKOVA (you)");
      expect(result).not.toContain("@SomeUser (you)");
    });
  });
});
