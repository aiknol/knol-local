/**
 * auto-setup.ts
 *
 * Three responsibilities:
 *  1. Write / patch MCP server entries into Claude Desktop and Cursor config files.
 *  2. Ensure better-sqlite3 is installed and usable (auto-install when missing or
 *     when the prebuilt binary was compiled for a different Node ABI).
 *  3. Install PostCompact hook in Claude Code (~/.claude/settings.json) so that
 *     session memories are captured automatically on context compaction.
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

let _mcpEntry: { command: string; args: string[] } | undefined;

function buildMcpEntry(): { command: string; args: string[] } {
  if (!_mcpEntry) {
    _mcpEntry = {
      command: process.execPath,
      args: [join(getPackageDir(), "dist", "index.js")],
    };
  }
  return _mcpEntry;
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
  try {
    // Parse existing config (or start with empty object)
    let config: Record<string, unknown> = {};
    let fileExisted = false;
    try {
      const raw = readFileSync(configPath, "utf8").trim();
      fileExisted = true;
      if (raw) {
        try {
          config = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return { label, path: configPath, action: "error", detail: "File contains invalid JSON — please fix it manually." };
        }
      }
    } catch {
      // File does not exist
      if (!createFile) return { label, path: configPath, action: "skipped" };
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

    if (!fileExisted) return { label, path: configPath, action: "created" };
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
  // Use the npm that ships alongside the currently running node binary.
  // This ensures the native module is compiled for the right Node ABI even
  // when nvm has switched versions since the global package was installed.
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const adjacentNpm = join(dirname(process.execPath), npmName);
  const npm = existsSync(adjacentNpm) ? `"${adjacentNpm}"` : npmName;

  process.stderr.write(
    `[knol-local] Node ${process.versions.node} — installing better-sqlite3 native binary…\n`,
  );

  // stderr is inherited so build errors reach the terminal
  const opts = { cwd: pkgDir, stdio: [null, null, "inherit"] as [null, null, "inherit"] };

  // First try a clean install; if that fails, try rebuilding the existing source
  try {
    execSync(`${npm} install better-sqlite3`, opts);
    return true;
  } catch {
    try {
      execSync(`${npm} rebuild better-sqlite3`, opts);
      return true;
    } catch {
      return false;
    }
  }
}

/** Derive the knol-local package root from this module's location (dist/auto-setup.js → package root). */
export function getPackageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

// ── Claude Code hook setup ─────────────────────────────────────────────────

export interface HookResult {
  action: "added" | "already-configured" | "error";
  detail?: string;
}

/**
 * Install a PostCompact hook in ~/.claude/settings.json so that knol-local
 * automatically captures session memories whenever Claude Code compacts context.
 *
 * The hook pipes the PostCompact JSON (which contains the session summary) into
 * `knol-local capture`, which extracts and stores individual memories.
 */
export function setupClaudeCodeHooks(): HookResult {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const entry = buildMcpEntry();
  // Hook command: PostCompact stdin → knol-local capture
  const hookCmd = `${entry.command} ${entry.args[0]} capture 2>/dev/null || true`;

  try {
    let settings: Record<string, unknown> = {};
    try {
      const raw = readFileSync(settingsPath, "utf8").trim();
      if (raw) settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // File doesn't exist yet — start fresh
    }

    if (!settings["hooks"] || typeof settings["hooks"] !== "object") {
      settings["hooks"] = {};
    }
    const hooks = settings["hooks"] as Record<string, unknown>;

    if (!Array.isArray(hooks["PostCompact"])) {
      hooks["PostCompact"] = [];
    }
    const postCompact = hooks["PostCompact"] as Array<Record<string, unknown>>;

    // Find any existing knol-local capture hook entry
    let existingEntryIdx = -1;
    let existingHookIdx  = -1;
    for (let i = 0; i < postCompact.length; i++) {
      const innerHooks = Array.isArray(postCompact[i]!["hooks"])
        ? (postCompact[i]!["hooks"] as Array<Record<string, unknown>>)
        : [];
      const j = innerHooks.findIndex(
        (h) => String(h["command"] ?? "").includes("knol-local") &&
               String(h["command"] ?? "").includes("capture"),
      );
      if (j !== -1) { existingEntryIdx = i; existingHookIdx = j; break; }
    }

    if (existingEntryIdx !== -1) {
      // Already present — check if the command points to the current binary
      const existing = postCompact[existingEntryIdx]!;
      const existingHook = (existing["hooks"] as Array<Record<string, unknown>>)[existingHookIdx]!;
      if (String(existingHook["command"]) === hookCmd) {
        return { action: "already-configured" };
      }
      // Stale path (e.g. after global reinstall) — update in place
      existingHook["command"] = hookCmd;
    } else {
      postCompact.push({
        hooks: [{ type: "command", command: hookCmd, timeout: 30 }],
      });
    }

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

    return { action: "added" };
  } catch (err) {
    return { action: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}
