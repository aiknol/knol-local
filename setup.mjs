#!/usr/bin/env node
/**
 * postinstall helper — runs automatically after `npm install -g knol-local`.
 *
 * Behaviour:
 *   1. Scans for Claude Desktop and Cursor config files.
 *   2. Appends the knol-local MCP server entry to any that already exist.
 *   3. Never creates config files that aren't there (no surprises).
 *   4. Always exits 0 so it can never block the npm install.
 *
 * Users can re-run this explicitly at any time:
 *   node /path/to/knol-local/setup.mjs
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const autoSetupPath = join(__dir, "dist", "auto-setup.js");

// Skip silently if the package hasn't been compiled yet (e.g. fresh clone).
if (!existsSync(autoSetupPath)) process.exit(0);

try {
  const { autoSetupMcpConfigs } = await import(autoSetupPath);
  const results = autoSetupMcpConfigs();

  for (const r of results) {
    if (r.action === "added" || r.action === "created" || r.action === "updated") {
      process.stdout.write(`[knol-local] ✓ Added MCP server entry → ${r.path}\n`);
      process.stdout.write(`[knol-local]   Restart ${r.label} to activate.\n`);
    } else if (r.action === "already-configured") {
      process.stdout.write(`[knol-local] ✓ ${r.label} already configured (${r.path})\n`);
    }
    // skipped / error → silent in postinstall to avoid alarming users
  }
} catch {
  // Never let postinstall failures surface — they'd break the npm install UX.
}
