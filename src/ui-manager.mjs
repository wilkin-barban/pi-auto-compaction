/**
 * UI notifications, status footer, widget, and herdr:blocked lifecycle manager.
 * Respects herdr's active counter: emits exactly ONE active:true per compaction cycle,
 * updates stage labels via UI without re-acquiring, and emits exactly ONE active:false
 * on terminal completion, failure, abort, or shutdown.
 */

export class UiManager {
  constructor(pi, ctx) {
    this.pi = pi;
    this.ctx = ctx;
    this.isHerdrBlocked = false;
    this.active = false;
    this.startTime = 0;
  }

  _acquireHerdr(label) {
    if (!this.isHerdrBlocked) {
      try {
        this.pi.events?.emit("herdr:blocked", { active: true, label });
        this.isHerdrBlocked = true;
      } catch {
        // Event emission failures must not break compaction
      }
    }
  }

  _releaseHerdr() {
    if (this.isHerdrBlocked) {
      this.isHerdrBlocked = false;
      try {
        this.pi.events?.emit("herdr:blocked", { active: false });
      } catch {
        // Event emission failures must not break compaction
      }
    }
  }

  startCompaction(reason, modelName) {
    this.active = true;
    this.startTime = Date.now();

    const label = "Compacting context (OmniRoute primary)...";
    this._acquireHerdr(label);

    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus("auto-compaction", label);
      this.ctx.ui.setWidget("auto-compaction", [
        "--- Automatic Context Compaction ---",
        `Stage: Primary summarizer (${modelName})`,
        `Trigger: ${reason}`,
      ]);
      this.ctx.ui.notify("Automatic context compaction started", "info");
    }
  }

  fallbackTransition(reason, fallbackModelName) {
    // Do NOT re-acquire herdr; update label only via UI
    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus("auto-compaction", "Compacting context (OmniRoute fallback)...");
      this.ctx.ui.setWidget("auto-compaction", [
        "--- Automatic Context Compaction ---",
        `Stage: Fallback summarizer (${fallbackModelName})`,
      ]);
      this.ctx.ui.notify("Primary summarizer failed, switching to fallback", "warning");
    }
  }

  nativeTransition() {
    // Keep active and herdr block acquired; update status to native Pi last resort
    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus("auto-compaction", "Compacting context (Pi native last resort)...");
      this.ctx.ui.setWidget("auto-compaction", [
        "--- Automatic Context Compaction ---",
        "Stage: Native Pi compaction (last resort)",
      ]);
      this.ctx.ui.notify("OmniRoute summarizers failed, falling back to Pi native compaction", "warning");
    }
  }

  completeCompaction(modelName, durationMs, tokensBefore) {
    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus("auto-compaction", undefined);
      this.ctx.ui.setWidget("auto-compaction", undefined);
      const elapsed = (durationMs / 1000).toFixed(1);
      const tokens = typeof tokensBefore === "number" ? tokensBefore.toLocaleString() : "context";
      this.ctx.ui.notify(`Compacted ${tokens} tokens via ${modelName} in ${elapsed}s`, "info");
    }

    this._releaseHerdr();
    this.active = false;
  }

  failCompaction(errorCategory, willRetry) {
    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus("auto-compaction", undefined);
      this.ctx.ui.setWidget("auto-compaction", undefined);
      this.ctx.ui.notify(`Compaction failed: [${errorCategory}]`, "error");
    }

    this._releaseHerdr();
    this.active = false;
  }

  cleanup() {
    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus("auto-compaction", undefined);
      this.ctx.ui.setWidget("auto-compaction", undefined);
    }
    this._releaseHerdr();
    this.active = false;
  }
}
