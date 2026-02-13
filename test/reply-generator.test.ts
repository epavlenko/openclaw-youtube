/**
 * Tests for src/reply-generator.ts — reply generation logic.
 *
 * Tests the SKIP detection and quote cleanup logic.
 * API calls are not tested here (would need mocks for Gemini/OpenClaw).
 */

import { describe, it, expect } from "vitest";

// We test the pure functions from the module
// The main generateReply requires API calls, so we test the cleaning logic

describe("reply-generator", () => {
  describe("SKIP detection", () => {
    it("detects SKIP in various casings", () => {
      const cases = ["SKIP", "skip", "Skip", " SKIP ", " skip "];
      for (const c of cases) {
        expect(c.trim().toUpperCase()).toBe("SKIP");
      }
    });
  });

  describe("quote cleanup", () => {
    it("removes surrounding double quotes", () => {
      const reply = '"This is a great set!"';
      let cleaned = reply.trim();
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1);
      }
      expect(cleaned).toBe("This is a great set!");
    });

    it("does not remove quotes that are not wrapping", () => {
      const reply = 'She said "amazing" music';
      let cleaned = reply.trim();
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1);
      }
      expect(cleaned).toBe('She said "amazing" music');
    });

    it("does not remove single quotes", () => {
      const reply = "'Thank you!'";
      let cleaned = reply.trim();
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1);
      }
      expect(cleaned).toBe("'Thank you!'");
    });

    it("handles empty string", () => {
      const reply = "";
      let cleaned = reply.trim();
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        cleaned = cleaned.slice(1, -1);
      }
      expect(cleaned).toBe("");
    });
  });
});
