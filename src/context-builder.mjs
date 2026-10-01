/**
 * Context preparation, capacity validation, and cumulative file tracking.
 */

function escapeXml(unsafe) {
  if (typeof unsafe !== "string") return "";
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function validateConversationCapacity(fullText, maxChars = 2500000) {
  if (!fullText) return "";
  if (fullText.length > maxChars) {
    const err = new Error(
      `Conversation text length (${fullText.length}) exceeded capacity budget (${maxChars}). Cannot safely summarize without losing decisions.`,
    );
    err.code = "conversation_too_large";
    throw err;
  }
  return fullText;
}

export function accumulateFileOperations(currentFileOps, branchEntries = [], maxEntryIndex = undefined) {
  const readSet = new Set();
  const modifiedSet = new Set();

  const entriesToScan =
    Array.isArray(branchEntries) && maxEntryIndex !== undefined
      ? branchEntries.slice(0, maxEntryIndex)
      : branchEntries;

  // 1. Recover files from previous compaction entries in branchEntries
  if (Array.isArray(entriesToScan)) {
    for (const entry of entriesToScan) {
      if (entry?.type === "compaction") {
        if (entry.details) {
          const { readFiles, modifiedFiles } = entry.details;
          if (Array.isArray(readFiles)) {
            for (const f of readFiles) if (typeof f === "string") readSet.add(f);
          }
          if (Array.isArray(modifiedFiles)) {
            for (const f of modifiedFiles) if (typeof f === "string") modifiedSet.add(f);
          }
        }

        // Also check XML tags in summary for completeness
        if (typeof entry.summary === "string") {
          const readMatch = entry.summary.match(/<read-files>([\s\S]*?)<\/read-files>/);
          if (readMatch) {
            for (const line of readMatch[1].split("\n")) {
              const trimmed = line.trim();
              if (trimmed) readSet.add(trimmed);
            }
          }
          const modMatch = entry.summary.match(/<modified-files>([\s\S]*?)<\/modified-files>/);
          if (modMatch) {
            for (const line of modMatch[1].split("\n")) {
              const trimmed = line.trim();
              if (trimmed) modifiedSet.add(trimmed);
            }
          }
        }
      } else if (entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block?.type === "toolCall" && block.arguments?.path) {
            if (block.name === "read") readSet.add(block.arguments.path);
            if (block.name === "write" || block.name === "edit") modifiedSet.add(block.arguments.path);
          }
        }
      }
    }
  }

  // 2. Add current turn fileOps
  if (currentFileOps) {
    if (currentFileOps.read instanceof Set) {
      for (const f of currentFileOps.read) readSet.add(f);
    } else if (Array.isArray(currentFileOps.read)) {
      for (const f of currentFileOps.read) readSet.add(f);
    }

    if (currentFileOps.written instanceof Set) {
      for (const f of currentFileOps.written) modifiedSet.add(f);
    } else if (Array.isArray(currentFileOps.written)) {
      for (const f of currentFileOps.written) modifiedSet.add(f);
    }

    if (currentFileOps.edited instanceof Set) {
      for (const f of currentFileOps.edited) modifiedSet.add(f);
    } else if (Array.isArray(currentFileOps.edited)) {
      for (const f of currentFileOps.edited) modifiedSet.add(f);
    }
  }

  // Modified files take precedence over read files
  const readFiles = [...readSet].filter((f) => !modifiedSet.has(f)).sort();
  const modifiedFiles = [...modifiedSet].sort();

  return { readFiles, modifiedFiles };
}

export function formatFileOpsSection(readFiles = [], modifiedFiles = []) {
  const sections = [];
  if (Array.isArray(readFiles) && readFiles.length > 0) {
    const escaped = readFiles.map(escapeXml);
    sections.push(`<read-files>\n${escaped.join("\n")}\n</read-files>`);
  }
  if (Array.isArray(modifiedFiles) && modifiedFiles.length > 0) {
    const escaped = modifiedFiles.map(escapeXml);
    sections.push(`<modified-files>\n${escaped.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

export function buildSummarizerMessages({
  conversationText,
  previousSummary,
  customInstructions,
  maxPromptChars = 2500000,
}) {
  const previousContext = previousSummary
    ? `\n\nPrevious session summary for context:\n${previousSummary}`
    : "";

  const focusInstructions = customInstructions
    ? `\n\nSpecial focus instructions:\n${customInstructions}`
    : "";

  const promptText = `You are a context summarization assistant. Produce a structured summary of the conversation history following this exact format:

## Goal
[What the user is trying to accomplish and original intent]

## Constraints & Preferences
- [Explicit constraints, rules, environment restrictions]

## Progress
### Done
- [x] [Completed tasks and verified milestones]

### In Progress
- [ ] [Active uncommitted work]

### Blocked
- [Active technical or environmental blockers, if any]

## Key Decisions
- **[Decision]**: [Technical rationale and chosen approach]

## Next Steps
1. [Clear sequential actionable steps]

## Critical Context
- [Active state, commands, test outcomes, or file paths needed to continue seamlessly]
${previousContext}${focusInstructions}

Do NOT continue the conversation or answer questions. Output ONLY the structured markdown summary.

<conversation>
${conversationText}
</conversation>`;

  if (promptText.length > maxPromptChars) {
    const err = new Error(
      `Complete summarizer prompt length (${promptText.length}) exceeded capacity limit (${maxPromptChars}).`,
    );
    err.code = "conversation_too_large";
    throw err;
  }

  return [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now(),
    },
  ];
}
