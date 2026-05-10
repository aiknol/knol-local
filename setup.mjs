#!/usr/bin/env node
/**
 * postinstall helper — runs automatically after `npm install -g knol-local`.
 *
 * Behaviour:
 *   1. On Node < 22.5: installs better-sqlite3 (native SQLite fallback).
 *   2. Scans for Claude Desktop and Cursor config files.
 *   3. Appends the knol-local MCP server entry to any that already exist.
 *   4. Never creates config files that aren't there (no surprises).
 *   5. Always exits 0 so it can never block the npm install.
 *
 * Users can re-run this explicitly at any time:
 *   node /path/to/knol-local/setup.mjs
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Use stderr for all output — npm suppresses postinstall stdout in many
// environments (npm 7+, non-TTY, CI) but always forwards stderr.
const log = (msg) => process.stderr.write(msg + "\n");

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Step 1: conditionally install better-sqlite3 on Node < 22.5 ──────────────
//
// node:sqlite is only available in Node 22.5+.  Claude Desktop and some other
// environments embed Node 18, so we install better-sqlite3 as an on-demand
// dependency for those users.  Node 22.5+ users skip this entirely, avoiding
// the prebuild-install deprecation warning.

try {
  const [major, minor] = process.versions.node.split(".").slice(0, 2).map(Number);
  const needsBetterSqlite = major < 22 || (major === 22 && minor < 5);

  if (needsBetterSqlite) {
    const betterSqlitePath = join(__dir, "node_modules", "better-sqlite3");
    if (!existsSync(betterSqlitePath)) {
      log(`[knol-local] Node ${process.versions.node} — installing better-sqlite3 (native SQLite fallback)…`);
      const { execSync } = await import("node:child_process");
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      execSync(`${npm} install better-sqlite3`, { cwd: __dir, stdio: "inherit" });
      log(`[knol-local] ✓ better-sqlite3 installed.`);
    }
  }
} catch {
  // Never block the install — sqlite.ts has its own repair path as a fallback.
}

// ── Step 2: patch MCP config files ───────────────────────────────────────────

const autoSetupPath = join(__dir, "dist", "auto-setup.js");

// Skip silently if the package hasn't been compiled yet (e.g. fresh clone).
if (!existsSync(autoSetupPath)) process.exit(0);

try {
  const { autoSetupMcpConfigs } = await import(autoSetupPath);
  const results = autoSetupMcpConfigs();

  const configured = [];
  const skipped = [];

  for (const r of results) {
    if (r.action === "added" || r.action === "created" || r.action === "updated") {
      log(`[knol-local] ✓ ${r.label}: added MCP server entry`);
      log(`[knol-local]   → ${r.path}`);
      log(`[knol-local]   Restart ${r.label} to activate.`);
      configured.push(r.label);
    } else if (r.action === "already-configured") {
      log(`[knol-local] ✓ ${r.label}: already configured`);
      configured.push(r.label);
    } else if (r.action === "skipped") {
      skipped.push(r.label);
    }
    // error → silent in postinstall to avoid alarming users
  }

  // If no config files were found at all, guide the user.
  if (configured.length === 0 && skipped.length > 0) {
    log(`[knol-local] No existing MCP config files found.`);
    log(`[knol-local] Run one of the following to configure your client:`);
    log(`[knol-local]   knol-local setup claude       # Claude Desktop`);
    log(`[knol-local]   knol-local setup cursor        # Cursor`);
    log(`[knol-local]   knol-local setup claude-code   # Claude Code CLI`);
  }
} catch {
  // Never let postinstall failures surface — they'd break the npm install UX.
}
