import { resolveActiveConfig } from "./config.mjs";
import { writeSettings } from "./summarizer-settings.mjs";

/**
 * Holds the live configuration of the compaction extension.
 *
 * The runtime resolves the effective configuration once at startup and can
 * later replace it in place, so the next `session_before_compact` cycle reads
 * the new summarizer models without reloading the extension. A failed save
 * leaves the previous configuration untouched.
 */
export function createRuntimeConfig(options = {}, deps = {}) {
  const resolveConfigFn = deps.resolveActiveConfig || resolveActiveConfig;
  const writeSettingsFn = deps.writeSettings || writeSettings;

  let current = resolveConfigFn(options);

  return {
    get() {
      return current;
    },

    /**
     * Re-reads the settings file and env, keeping explicit options on top.
     */
    reload() {
      current = resolveConfigFn(options);
      return current;
    },

    /**
     * Persists new summarizer settings atomically and, only after the write
     * succeeds, swaps the live configuration. Throws on validation or I/O
     * failure with the previous configuration still active.
     */
    saveSummarizerSettings(settings) {
      const path = writeSettingsFn(settings, {
        settingsPath: options.settingsPath,
        env: options.env,
        agentDir: options.agentDir,
      });

      current = resolveConfigFn({
        ...options,
        primaryModel: undefined,
        fallbackModel: undefined,
      });

      return { path, config: current };
    },
  };
}
