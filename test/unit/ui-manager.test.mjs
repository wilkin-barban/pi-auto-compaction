import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UiManager } from "../../src/ui-manager.mjs";

describe("ui-manager module", () => {
  function createMockEnv() {
    const statuses = new Map();
    const widgets = new Map();
    const notifications = [];
    const events = [];

    // Simulate herdr-agent-state.ts exact counter logic
    let herdrBlockedCount = 0;
    let herdrBlockedMessage;

    const mockPi = {
      events: {
        emit(event, data) {
          events.push({ event, data });
          if (event === "herdr:blocked") {
            if (data?.active) {
              herdrBlockedCount += 1;
              herdrBlockedMessage = data.label;
            } else {
              herdrBlockedCount = Math.max(0, herdrBlockedCount - 1);
              if (herdrBlockedCount === 0) {
                herdrBlockedMessage = undefined;
              }
            }
          }
        },
      },
    };

    const mockCtx = {
      hasUI: true,
      mode: "tui",
      ui: {
        setStatus(key, text) {
          if (text === undefined) statuses.delete(key);
          else statuses.set(key, text);
        },
        setWidget(key, lines) {
          if (lines === undefined) widgets.delete(key);
          else widgets.set(key, lines);
        },
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    };

    return {
      mockPi,
      mockCtx,
      statuses,
      widgets,
      notifications,
      events,
      getHerdrCount: () => herdrBlockedCount,
      getHerdrMessage: () => herdrBlockedMessage,
    };
  }

  it("emits herdr:blocked { active: true } on compaction start and sets UI status", () => {
    const env = createMockEnv();
    const ui = new UiManager(env.mockPi, env.mockCtx);

    ui.startCompaction("threshold", "omniroute/antigravity/gemini-3.8-flash-tiered");

    assert.ok(env.statuses.has("auto-compaction"));
    assert.ok(env.statuses.get("auto-compaction").includes("primary"));

    assert.equal(env.getHerdrCount(), 1);
    assert.equal(env.getHerdrMessage(), "Compacting context (OmniRoute primary)...");
  });

  it("updates UI on fallback and native transitions WITHOUT acquiring additional herdr blocks", () => {
    const env = createMockEnv();
    const ui = new UiManager(env.mockPi, env.mockCtx);

    // Initial compaction acquire
    ui.startCompaction("threshold", "primary-model");
    assert.equal(env.getHerdrCount(), 1);

    // Transition to fallback
    ui.fallbackTransition("primary failed", "omniroute/antigravity/gemini-3.6-flash-high");
    assert.equal(env.getHerdrCount(), 1, "Must NOT acquire second block on fallback");
    assert.ok(env.statuses.get("auto-compaction").includes("fallback"));

    // Transition to native
    ui.nativeTransition();
    assert.equal(env.getHerdrCount(), 1, "Must NOT acquire third block on native transition");
    assert.ok(env.statuses.get("auto-compaction").includes("native"));
    assert.ok(ui.active, "UI state must remain active until terminal completion/failure");

    // Complete compaction
    ui.completeCompaction("native", 2000, 200000);
    assert.equal(env.getHerdrCount(), 0, "Must be completely released without block leaks");
  });

  it("preserves external pre-existing herdr blocker when compaction starts and finishes", () => {
    const env = createMockEnv();
    // Simulate pre-existing external blocker (e.g. human interaction required)
    env.mockPi.events.emit("herdr:blocked", { active: true, label: "External human review" });
    assert.equal(env.getHerdrCount(), 1);

    const ui = new UiManager(env.mockPi, env.mockCtx);
    ui.startCompaction("threshold", "primary-model");
    assert.equal(env.getHerdrCount(), 2, "Compaction acquires 1 block on top of external blocker");

    ui.completeCompaction("primary-model", 1000, 100000);
    assert.equal(env.getHerdrCount(), 1, "After compaction release, external blocker remains intact");
  });

  it("cleans up herdr:blocked and UI on failure", () => {
    const env = createMockEnv();
    const ui = new UiManager(env.mockPi, env.mockCtx);

    ui.startCompaction("threshold", "primary-model");
    ui.failCompaction("timeout", false);

    assert.equal(env.getHerdrCount(), 0);
    assert.equal(env.statuses.has("auto-compaction"), false);
  });

  it("is idempotent on cleanup and never releases more than acquired", () => {
    const env = createMockEnv();
    const ui = new UiManager(env.mockPi, env.mockCtx);

    ui.cleanup();
    assert.equal(env.getHerdrCount(), 0);

    ui.startCompaction("threshold", "primary-model");
    assert.equal(env.getHerdrCount(), 1);

    ui.cleanup();
    ui.cleanup(); // duplicate cleanup
    assert.equal(env.getHerdrCount(), 0);
  });
});
