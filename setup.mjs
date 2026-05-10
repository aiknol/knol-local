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
      process.stdout.write(
        `[knol-local] Node ${process.versions.node} — installing better-sqlite3 (native SQLite fallback)…\n`,
      );
      const { execSync } = await import("node:child_process");
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      execSync(`${npm} install better-sqlite3`, { cwd: __dir, stdio: "inherit" });
      process.stdout.write(`[knol-local] ✓ better-sqlite3 installed.\n`);
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
