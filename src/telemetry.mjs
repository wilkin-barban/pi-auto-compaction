import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./config.mjs";

const ALLOWLISTED_FIELDS = new Set([
  "timestamp",
  "sessionId",
  "reason",
  "model",
  "status",
  "durationMs",
  "tokensBefore",
  "usage",
  "attemptCount",
  "errorCategory",
]);

function sanitizeUsage(rawUsage) {
  if (typeof rawUsage !== "object" || rawUsage === null) return undefined;

  const sanitized = {};
  const allowedNumericKeys = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "totalTokens",
    "inputTokens",
    "outputTokens",
  ];

  for (const k of allowedNumericKeys) {
    if (typeof rawUsage[k] === "number" && Number.isFinite(rawUsage[k])) {
      sanitized[k] = rawUsage[k];
    }
  }

  // Cost sub-object: only keep finite numeric values
  if (typeof rawUsage.cost === "object" && rawUsage.cost !== null) {
    const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"];
    const sanitizedCost = {};
    for (const ck of costKeys) {
      if (typeof rawUsage.cost[ck] === "number" && Number.isFinite(rawUsage.cost[ck])) {
        sanitizedCost[ck] = rawUsage.cost[ck];
      }
    }
    if (Object.keys(sanitizedCost).length > 0) {
      sanitized.cost = sanitizedCost;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export class TelemetryLogger {
  constructor(options = {}) {
    this.telemetryPath = options.telemetryPath || DEFAULT_CONFIG.telemetryPath;
    this.maxBytes = options.telemetryMaxBytes || DEFAULT_CONFIG.telemetryMaxBytes;
    this.maxFiles = options.telemetryMaxFiles || DEFAULT_CONFIG.telemetryMaxFiles;
    this.terminalCycles = new Set();
  }

  _ensureDir() {
    const dir = path.dirname(this.telemetryPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // Best effort
      }
    }
  }

  _rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.telemetryPath)) return;
      const stat = fs.statSync(this.telemetryPath);
      if (stat.size >= this.maxBytes) {
        for (let i = this.maxFiles - 1; i >= 1; i--) {
          const src = `${this.telemetryPath}.${i}`;
          const dst = `${this.telemetryPath}.${i + 1}`;
          if (fs.existsSync(src)) {
            if (i + 1 > this.maxFiles) {
              fs.rmSync(src, { force: true });
            } else {
              fs.renameSync(src, dst);
            }
          }
        }
        fs.renameSync(this.telemetryPath, `${this.telemetryPath}.1`);
      }
    } catch {
      // Rotation failures must not ruin compaction
    }
  }

  writeRecord(rawRecord) {
    try {
      this._ensureDir();
      this._rotateIfNeeded();

      const record = {
        timestamp: new Date().toISOString(),
      };

      for (const [key, value] of Object.entries(rawRecord)) {
        if (!ALLOWLISTED_FIELDS.has(key) || value === undefined) {
          continue;
        }

        if (key === "usage") {
          const safeUsage = sanitizeUsage(value);
          if (safeUsage) {
            record.usage = safeUsage;
          }
        } else if (key === "attemptCount") {
          if (typeof value === "number" && Number.isInteger(value) && value > 0) {
            record.attemptCount = value;
          }
        } else if (key === "durationMs" || key === "tokensBefore") {
          if (typeof value === "number" && Number.isFinite(value)) {
            record[key] = value;
          }
        } else if (typeof value === "string") {
          record[key] = value;
        }
      }

      const line = `${JSON.stringify(record)}\n`;
      fs.appendFileSync(this.telemetryPath, line, { mode: 0o600 });
      try {
        fs.chmodSync(this.telemetryPath, 0o600);
      } catch {
        // Best effort
      }
    } catch {
      // Telemetry errors must never fail compaction
    }
  }

  recordTerminalSuccess(data) {
    const cycleId = data.cycleId || `${data.sessionId}:${data.tokensBefore}`;
    if (this.terminalCycles.has(cycleId)) {
      return;
    }
    this.terminalCycles.add(cycleId);

    this.writeRecord({
      sessionId: data.sessionId,
      reason: data.reason,
      model: data.model,
      status: "success",
      durationMs: data.durationMs,
      tokensBefore: data.tokensBefore,
      usage: data.usage,
      attemptCount: data.attemptCount || 1,
    });
  }

  recordTerminalFailure(data) {
    const cycleId = data.cycleId || `${data.sessionId}:${data.tokensBefore}`;
    if (this.terminalCycles.has(cycleId)) {
      return;
    }
    this.terminalCycles.add(cycleId);

    this.writeRecord({
      sessionId: data.sessionId,
      reason: data.reason,
      model: data.model,
      status: "failed",
      durationMs: data.durationMs,
      tokensBefore: data.tokensBefore,
      attemptCount: data.attemptCount || 1,
      errorCategory: data.errorCategory || "unknown",
    });
  }
}
