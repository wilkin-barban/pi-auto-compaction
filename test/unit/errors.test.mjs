import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError, sanitizeErrorMessage } from "../../src/errors.mjs";

describe("errors module", () => {
  it("classifies timeout errors", () => {
    const err = new Error("The operation timed out");
    err.name = "TimeoutError";
    assert.equal(classifyError(err), "timeout");
  });

  it("classifies abort errors", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    assert.equal(classifyError(err), "abort");
  });

  it("classifies length cap errors", () => {
    const err = new Error("generation hit the token cap and the summary is incomplete");
    assert.equal(classifyError(err), "length_cap");
  });

  it("classifies empty summary errors", () => {
    const err = new Error("Compaction summary was empty");
    assert.equal(classifyError(err), "empty_summary");
  });

  it("classifies tool calls rejected errors", () => {
    const err = new Error("Summary contained tool calls which are prohibited");
    assert.equal(classifyError(err), "tool_calls_rejected");
  });

  it("classifies auth errors without exposing keys", () => {
    const err = new Error("No API key found for provider omniroute");
    assert.equal(classifyError(err), "auth_failed");
  });

  it("classifies rate limit errors", () => {
    const err = new Error("HTTP 429 Too Many Requests");
    assert.equal(classifyError(err), "rate_limit");
  });

  it("classifies enormous summary errors", () => {
    const err = new Error("Summary exceeded maximum allowed character threshold");
    assert.equal(classifyError(err), "enormous_summary");
  });

  it("classifies serialization limit errors", () => {
    const err = new Error("Conversation text exceeded serialization safety boundary");
    assert.equal(classifyError(err), "serialization_limit");
  });

  it("sanitizes error messages removing tokens, keys and user home paths", () => {
    // Synthetic fixtures, not real credentials: `sk-ant-api03-...` only mimics the
    // shape of an API key and `/home/example/...` only mimics a user home path. Both
    // exist to prove that sanitizeErrorMessage redacts them; they grant no access to
    // anything. See SECURITY.md, "Fixtures de prueba".
    const raw = "Error: request failed with auth Bearer sk-ant-api03-abcdef1234567890 at /home/example/Desktop/secret/file.txt";
    const sanitized = sanitizeErrorMessage(raw);
    assert.ok(!sanitized.includes("sk-ant-api03-abcdef1234567890"), "Must not leak API key");
    assert.ok(!sanitized.includes("/home/example/"), "Must not leak home path");
    assert.ok(sanitized.includes("[REDACTED_SECRET]") || sanitized.includes("[REDACTED_PATH]"), "Must replace sensitive tokens");
  });
});
