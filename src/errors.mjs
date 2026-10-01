/**
 * Safe error classification and sanitization.
 * Prevents raw provider errors, API keys, tokens, and private paths
 * from leaking into UI notifications or telemetry logs.
 */

export function classifyError(error) {
  if (!error) return "unknown";

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

  if (name === "TimeoutError" || code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) {
    return "timeout";
  }

  if (name === "AbortError" || /abort/i.test(message)) {
    return "abort";
  }

  if (/token cap|stopReason:?\s*"?length"?|hit the token cap/i.test(message)) {
    return "length_cap";
  }

  if (/empty|no summary/i.test(message)) {
    return "empty_summary";
  }

  if (/tool calls?|toolUse/i.test(message)) {
    return "tool_calls_rejected";
  }

  if (/no api key|unauthorized|auth|credentials|login/i.test(message)) {
    return "auth_failed";
  }

  if (/429|rate limit|too many requests/i.test(message)) {
    return "rate_limit";
  }

  if (/model not found|cannot find model|unknown model/i.test(message)) {
    return "model_not_found";
  }

  if (/enormous|character threshold|exceeded maximum allowed/i.test(message)) {
    return "enormous_summary";
  }

  if (/serialization|safety boundary/i.test(message)) {
    return "serialization_limit";
  }

  if (/provider|500|502|503|504|gateway/i.test(message)) {
    return "provider_error";
  }

  return "unknown";
}

export function sanitizeErrorMessage(raw) {
  if (!raw) return "Unknown error";
  let message = typeof raw === "string" ? raw : (raw instanceof Error ? raw.message : String(raw));

  // Strip bearer tokens and keys (sk-*, Bearer *, api-keys)
  message = message.replace(/(?:Bearer\s+|sk-)[a-zA-Z0-9_\-\.]{8,}/g, "[REDACTED_SECRET]");
  message = message.replace(/key=[a-zA-Z0-9_\-\.]{8,}/gi, "key=[REDACTED_SECRET]");
  message = message.replace(/password=[^\s&]+/gi, "password=[REDACTED_SECRET]");

  // Strip user home paths (/home/... or /Users/...)
  message = message.replace(/(?:\/home\/[a-zA-Z0-9_\-]+|\/Users\/[a-zA-Z0-9_\-]+)[^\s"':]*/g, "[REDACTED_PATH]");

  // Strip raw stack trace lines
  const lines = message.split("\n");
  const filtered = lines.filter((l) => !l.trim().startsWith("at "));
  return filtered.join("\n").trim() || "Sanitized error";
}
