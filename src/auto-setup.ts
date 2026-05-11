/**
 * auto-setup.ts
 *
 * Two responsibilities:
 *  1. Write / patch MCP server entries into Claude Desktop and Cursor config files.
 *  2. Ensure better-sqlite3 is installed and usable (auto-install when missing or
 *     when the prebuilt binary was compiled for a different Node ABI).
 *
 * This module is imported by:
 *   - setup.mjs   (postinstall — runs after `npm install -g knol-local`)
 *   - cli.ts      (knol-local setup command)
 *   - sqlite.ts   (on-demand dependency repair)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── MCP entry ──────────────────────────────────────────────────────────────
//
// Claude Desktop (and some other Electron apps) launch with a stripped PATH
// that does not include nvm, fnm, or npm global bin directories.  Using a
// bare "knol-local" command therefore fails with ENOENT even if the binary
// works fine in the terminal.
//
// Fix: write the absolute path to the Node binary + the absolute path to
// dist/index.js.  Both are known at setup time:
//   - process.execPath → the Node binary that is running right now
//   - getPackageDir()  → the installed package root (dist/index.js lives here)
//
// Result in the config:
//   { "command": "/Users/…/.nvm/…/bin/node",
//     "args":    ["/Users/…/node_modules/knol-local/dist/index.js"] }

const MCP_KEY = "knol-local";

function buildMcpEntry(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [join(getPackageDir(), "dist", "index.js")],
  };
}

/** Returns true when an existing config entry already points at the right binary+script. */
function isMcpEntryCorrect(existing: Record<string, unknown>): boolean {
  const entry = buildMcpEntry();
  const args = Array.isArray(existing["args"]) ? (existing["args"] as unknown[]) : [];
  return (
    String(existing["command"] ?? "") === entry.command &&
    String(args[0] ?? "") === entry.args[0]
  );
}

// ── Config-file paths ──────────────────────────────────────────────────────

/** Claude Desktop config file location, per platform. */
export function claudeDesktopConfigPath(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32": {
      const appData = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
      return join(appData, "Claude", "claude_desktop_config.json");
    }
    default: // Linux + others
      return join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

/** Cursor global MCP config file location (same on all platforms). */
export function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

/** Claude Code (CLI) stores MCP config here. */
export function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

// ── Result type ────────────────────────────────────────────────────────────

export interface ConfigResult {
  label: string;
  path: string;
  /** What the function did to this file. */
  action: "added" | "updated" | "already-configured" | "skipped" | "created" | "error";
  /** Human-readable detail (used for error messages). */
  detail?: string;
}

// ── Core writer ───────────────────────────────────────────────────────────

/**
 * Merge the knol-local MCP entry into a JSON config file.
 *
 * @param configPath  Absolute path to the config file.
 * @param label       Human label shown in output (e.g. "Claude Desktop").
 * @param createFile  When true, create the file (and parent dirs) if missing.
 */
export function writeMcpEntry(
  configPath: string,
  label: string,
  createFile = false,
): ConfigResult {
  const fileExists = existsSync(configPath);

  if (!fileExists && !createFile) {
    return { label, path: configPath, action: "skipped" };
  }

  try {
    // Parse existing config (or start with empty object)
    let config: Record<string, unknown> = {};
    if (fileExists) {
      const raw = readFileSync(configPath, "utf8").trim();
      if (raw) {
        try {
          config = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return { label, path: configPath, action: "error", detail: "File contains invalid JSON — please fix it manually." };
        }
      }
    }

    // Ensure mcpServers object exists
    if (!config["mcpServers"] || typeof config["mcpServers"] !== "object" || Array.isArray(config["mcpServers"])) {
      config["mcpServers"] = {};
    }
    const servers = config["mcpServers"] as Record<string, unknown>;

    // Already has the correct entry → nothing to do
    const existing = servers[MCP_KEY] as Record<string, unknown> | undefined;
    if (existing && isMcpEntryCorrect(existing)) {
      return { label, path: configPath, action: "already-configured" };
    }

    const isUpdate = !!existing;
    servers[MCP_KEY] = buildMcpEntry();

    // Write (create parent dirs if needed)
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    if (!fileExists) return { label, path: configPath, action: "created" };
    return { label, path: configPath, action: isUpdate ? "updated" : "added" };
  } catch (err) {
    return { label, path: configPath, action: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Auto-detect mode: scan all known config files and patch those that already
 * exist. Files that do not exist are silently skipped (we never create them
 * uninvited in auto mode).
 *
 * Called by the postinstall script (`setup.mjs`) so it never blocks `npm install`.
 */
export function autoSetupMcpConfigs(): ConfigResult[] {
  return [
    writeMcpEntry(claudeDesktopConfigPath(), "Claude Desktop"),
    writeMcpEntry(cursorConfigPath(), "Cursor"),
  ];
}

/**
 * Explicit mode: configure a specific client, creating the config file when
 * it does not yet exist (with proper directory scaffolding).
 *
 * Called by `knol-local setup claude` / `knol-local setup cursor`.
 */
export function setupClient(client: "claude" | "cursor"): ConfigResult {
  switch (client) {
    case "claude":
      return writeMcpEntry(claudeDesktopConfigPath(), "Claude Desktop", true);
    case "cursor":
      return writeMcpEntry(cursorConfigPath(), "Cursor", true);
  }
}

/**
 * Ensure better-sqlite3 is installed and compatible with the current Node ABI.
 * When the binary is missing or was compiled for a different Node version,
 * runs `npm install better-sqlite3` inside the knol-local package directory.
 *
 * @param pkgDir  Root of the knol-local package (contains node_modules/).
 * @returns true if the install succeeded (or wasn't needed), false on failure.
 */
export function ensureBetterSqlite3(pkgDir: string): boolean {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    process.stderr.write(
      `[knol-local] Node ${process.versions.node} — installing better-sqlite3 native binary…\n`,
    );
    execSync(
      `${npm} install better-sqlite3`,
      { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

/** Derive the knol-local package root from this module's location (dist/auto-setup.js → package root). */
export function getPackageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
