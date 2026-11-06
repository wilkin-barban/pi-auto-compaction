/**
 * Test bootstrap: keeps every suite away from the developer's real agent
 * directory. Without it, a machine that already configured the summarizer
 * through `/compaction` changes the outcome of unit and integration tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-compaction-tests-"));

process.env.PI_AUTO_COMPACTION_SETTINGS_PATH = path.join(dir, ".pi-auto-compaction-settings.json");
process.env.PI_AUTO_COMPACTION_PRIMARY_PROVIDER = "";
process.env.PI_AUTO_COMPACTION_PRIMARY_MODEL = "";
process.env.PI_AUTO_COMPACTION_FALLBACK_PROVIDER = "";
process.env.PI_AUTO_COMPACTION_FALLBACK_MODEL = "";
