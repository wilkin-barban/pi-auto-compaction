import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateFileOperations,
  formatFileOpsSection,
  validateConversationCapacity,
  buildSummarizerMessages,
} from "../../src/context-builder.mjs";

describe("context-builder module", () => {
  it("accumulates file operations with modified precedence over read", () => {
    const currentFileOps = {
      read: new Set(["src/utils.ts", "src/shared.ts"]),
      written: new Set(["src/new-file.ts"]),
      edited: new Set(["src/shared.ts"]), // shared.ts is read AND edited
    };

    const branchEntries = [
      {
        type: "compaction",
        id: "prev-comp-1",
        fromHook: true,
        details: {
          readFiles: ["README.md"],
          modifiedFiles: ["package.json"],
        },
      },
    ];

    const { readFiles, modifiedFiles } = accumulateFileOperations(currentFileOps, branchEntries);

    // src/shared.ts was edited, so it must ONLY appear in modifiedFiles, NOT in readFiles
    assert.ok(modifiedFiles.includes("src/shared.ts"));
    assert.ok(!readFiles.includes("src/shared.ts"), "Modified file must not appear in readFiles");
    assert.deepEqual(modifiedFiles, ["package.json", "src/new-file.ts", "src/shared.ts"]);
    assert.deepEqual(readFiles, ["README.md", "src/utils.ts"]);
  });

  it("ignores future entries and only accumulates from prior compactions", () => {
    const currentFileOps = { read: new Set(["current.ts"]), written: new Set(), edited: new Set() };
    const branchEntries = [
      {
        type: "compaction",
        id: "past-comp",
        details: { readFiles: ["past.ts"], modifiedFiles: [] },
      },
      {
        type: "message",
        id: "cut-point-entry",
      },
      {
        type: "compaction",
        id: "future-comp", // future or alternate branch entry
        details: { readFiles: ["future.ts"], modifiedFiles: [] },
      },
    ];

    // Pass boundaryIndex = 1 (only inspect up to cut-point-entry)
    const { readFiles } = accumulateFileOperations(currentFileOps, branchEntries, 1);
    assert.ok(readFiles.includes("past.ts"));
    assert.ok(readFiles.includes("current.ts"));
    assert.ok(!readFiles.includes("future.ts"), "Must not include files from future entries");
  });

  it("escapes XML special characters in file paths", () => {
    const text = formatFileOpsSection(
      ["src/file<test>&name.ts"],
      ['src/quote"file\'name.ts'],
    );

    assert.ok(text.includes("src/file&lt;test&gt;&amp;name.ts"), "Must escape < > &");
    assert.ok(text.includes("src/quote&quot;file&apos;name.ts"), "Must escape quotes");
    assert.ok(!text.includes("<test>"), "Must not leave raw XML tags");
  });

  it("accepts synthetic large ~850,000 to 1,100,000 chars history under configured OmniRoute 1M capacity", () => {
    // 900,000 chars = ~225,000 tokens (chars/4 heuristic)
    const largeConvo = "User: We implemented auth and payments.\nAssistant: Verified all tests.\n".repeat(15000);
    assert.ok(largeConvo.length > 850000 && largeConvo.length < 1100000);

    // OmniRoute 1M context supports up to 2.5M chars
    const maxChars = 2500000;
    assert.doesNotThrow(() => validateConversationCapacity(largeConvo, maxChars));

    const messages = buildSummarizerMessages({
      conversationText: largeConvo,
      previousSummary: "## Goal\nComplete big project",
      maxPromptChars: maxChars,
    });

    assert.equal(messages.length, 1);
    assert.ok(messages[0].content[0].text.includes("We implemented auth and payments."));
  });

  it("rejects over-budget conversations with explicit capacity error rather than silently discarding decisions", () => {
    const largeConversation = "[User]: Decision 1\n[Assistant]: Action 1\n".repeat(5000);
    const maxChars = 2000;

    assert.throws(
      () => validateConversationCapacity(largeConversation, maxChars),
      (err) => err.code === "conversation_too_large" || err.message.includes("capacity"),
    );
  });

  it("accepts conversations within budget", () => {
    const safeText = "[User]: Goal 1\n[Assistant]: Decision 1";
    assert.doesNotThrow(() => validateConversationCapacity(safeText, 10000));
  });

  it("checks whole prompt sizing including instructions and previousSummary", () => {
    const hugeSummary = "Summary ".repeat(10000);
    assert.throws(
      () =>
        buildSummarizerMessages({
          conversationText: "Small convo",
          previousSummary: hugeSummary,
          maxPromptChars: 5000,
        }),
      (err) => err.code === "conversation_too_large",
    );
  });
});
