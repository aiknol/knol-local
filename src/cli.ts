import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { MemoryStore, type Memory, type SearchResult } from "./store.js";
import { startHttpServer } from "./http.js";
import {
  autoSetupMcpConfigs,
  setupClient,
  claudeDesktopConfigPath,
  cursorConfigPath,
  type ConfigResult,
} from "./auto-setup.js";

// ── ANSI colours ────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  yellow: "\x1b[33m",
};

function dim(s: string): string  { return `${c.dim}${s}${c.reset}`; }
function green(s: string): string { return `${c.green}${s}${c.reset}`; }
function red(s: string): string   { return `${c.red}${s}${c.reset}`; }
function bold(s: string): string  { return `${c.bold}${s}${c.reset}`; }
function cyan(s: string): string  { return `${c.cyan}${s}${c.reset}`; }

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function printTable(
  rows: Array<{ id: string; content: string; tags: string[]; importance: number; score?: number }>,
): void {
  if (rows.length === 0) {
    console.log(dim("  (no results)"));
    return;
  }
  const header = ["ID", "Content", "Tags", "Imp.", "Score"].map((h) => bold(h));
  const lines = rows.map((r) => [
    dim(shortId(r.id)),
    truncate(r.content, 50),
    r.tags.join(", ") || dim("—"),
    r.importance.toFixed(2),
    r.score !== undefined ? r.score.toFixed(4) : "",
  ]);

  const cols = [8, 50, 20, 4, 8];
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(cols[i] ?? 0)).join("  ");

  console.log(fmt(header));
  console.log(dim("─".repeat(cols.reduce((a, b) => a + b, 0) + cols.length * 2)));
  for (const line of lines) console.log(fmt(line));
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "-help") {
      flags["help"] = "true";
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      // single-char flags: -n 20, -t tag
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── Subcommands ──────────────────────────────────────────────────────────────

function cmdList(store: MemoryStore, args: string[]): void {
  const { flags } = parseArgs(args);
  const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 20;
  const tags = flags["tag"] ? [flags["tag"]] : undefined;
  const memories = store.list({ limit, tags });
  console.log(bold(`\nMemories (${memories.length}):\n`));
  printTable(memories);
  console.log();
}

function cmdAdd(store: MemoryStore, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const content = positional.join(" ").trim();
  if (!content) {
    console.error(red("Error: content is required"));
    process.exit(1);
  }
  const tags = flags["tag"] ? flags["tag"].split(",").filter(Boolean) : undefined;
  const importance = flags["importance"] ? parseFloat(flags["importance"]) : undefined;
  const memory = store.add(content, { tags, importance });
  console.log(green(`Stored: ${dim(memory.id)}`));
}

function cmdSearch(store: MemoryStore, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(" ").trim();
  const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 10;
  const tags = flags["tag"] ? flags["tag"].split(",").filter(Boolean) : undefined;
  const results: SearchResult[] = store.search(query, { limit, tags });
  console.log(bold(`\nSearch results for "${query}" (${results.length}):\n`));
  printTable(results);
  console.log();
}

function cmdStats(store: MemoryStore): void {
  const s = store.stats();
  console.log(bold("\nMemory stats:\n"));
  console.log(`  Total:   ${cyan(String(s.total))}`);
  console.log(`  Oldest:  ${s.oldest ? fmtDate(s.oldest) : dim("—")}`);
  console.log(`  Newest:  ${s.newest ? fmtDate(s.newest) : dim("—")}`);
  console.log();
}

function cmdExport(store: MemoryStore, args: string[]): void {
  const { flags } = parseArgs(args);
  const memories = store.exportAll();
  const payload = JSON.stringify(
    {
      version: "0.2.0",
      exported_at: new Date().toISOString(),
      count: memories.length,
      memories,
    },
    null,
    2,
  );
  if (flags["out"]) {
    fs.writeFileSync(flags["out"], payload, "utf8");
    console.log(green(`Exported ${memories.length} memories to ${flags["out"]}`));
  } else {
    process.stdout.write(payload + "\n");
  }
}

function cmdImport(store: MemoryStore, args: string[]): void {
  const { positional } = parseArgs(args);
  const file = positional[0];
  if (!file) {
    console.error(red("Error: file path is required"));
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(red(`Error: file not found: ${file}`));
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw) as { memories?: unknown[] };
  const entries = Array.isArray(data.memories) ? data.memories : (Array.isArray(data) ? data : []);
  const result = store.importAll(
    entries as Array<{
      content: string;
      tags?: string[];
      importance?: number;
      metadata?: Record<string, unknown>;
      created_at?: number;
    }>,
  );
  console.log(green(`Import complete: ${result.imported} imported, ${result.skipped} skipped`));
}

async function cmdBackup(store: MemoryStore, args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const backupDir = flags["out"]
    ? flags["out"]
    : path.join(os.homedir(), ".knol-local", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const destPath = path.join(backupDir, `memories-${ts}.db`);
  await store.backup(destPath);
  console.log(green(`Backup saved: ${destPath}`));
}

async function cmdRestore(store: MemoryStore, args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const file = positional[0];
  if (!file) {
    console.error(red("Error: backup file path is required"));
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(red(`Error: file not found: ${file}`));
    process.exit(1);
  }
  const dbPath = process.env["KNOL_LOCAL_DB"] ?? path.join(os.homedir(), ".knol-local", "memories.db");
  console.log(red(`WARNING: This will replace the current database at:\n  ${dbPath}`));
  const ok = await confirm("Are you sure? (y/N) ");
  if (!ok) {
    console.log(dim("Restore cancelled."));
    return;
  }
  store.close();
  fs.copyFileSync(file, dbPath);
  console.log(green(`Restored database from ${file}`));
}

function printConfigResult(r: ConfigResult): void {
  const icon =
    r.action === "added"              ? green("✓") :
    r.action === "created"            ? green("✓") :
    r.action === "updated"            ? green("✓") :
    r.action === "already-configured" ? dim("·") :
    r.action === "skipped"            ? dim("–") :
    /* error */                         red("✗");

  const desc =
    r.action === "added"              ? "added MCP entry" :
    r.action === "created"            ? "created config with MCP entry" :
    r.action === "updated"            ? "updated MCP entry" :
    r.action === "already-configured" ? "already configured" :
    r.action === "skipped"            ? "not found — skipped" :
    /* error */                         `error: ${r.detail ?? "unknown"}`;

  console.log(`  ${icon}  ${bold(r.label)}: ${desc}`);
  if (r.action !== "skipped" && r.action !== "error") {
    console.log(`     ${dim(r.path)}`);
  }
}

function cmdSetup(args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const target = positional[0] ?? "";
  const httpPort = flags["http-port"] ?? "3001";

  // ── codex: HTTP-only, show instructions ───────────────────────────────────
  if (target === "codex") {
    console.log(bold("\nCodex / ChatGPT setup:\n"));
    console.log("Codex does not support MCP. Use the built-in HTTP API instead:");
    console.log();
    console.log(`  1. Start the HTTP server:`);
    console.log(cyan(`       knol-local serve --port ${httpPort}`));
    console.log();
    console.log(`  2. Point Codex at ${cyan(`http://localhost:${httpPort}`)}`);
    console.log();
    console.log(dim("  Endpoints: GET /memories  POST /memories  GET /memories/search"));
    console.log(dim("             GET /export    POST /import    GET /health"));
    console.log();
    return;
  }

  // ── claude-code / code: show `claude mcp add` command ────────────────────
  if (target === "claude-code" || target === "code") {
    console.log(bold("\nClaude Code (CLI) setup:\n"));
    console.log("  Run this once in your terminal:");
    console.log();
    console.log(cyan("    claude mcp add knol-local knol-local"));
    console.log();
    console.log(dim("  Or set it per-project in .claude/settings.json:"));
    console.log(dim('    { "mcpServers": { "knol-local": { "command": "knol-local" } } }'));
    console.log();
    return;
  }

  // ── explicit single target ─────────────────────────────────────────────────
  if (target === "claude" || target === "cursor") {
    const label = target === "claude" ? "Claude Desktop" : "Cursor";
    console.log(bold(`\n${label} setup:\n`));
    const r = setupClient(target);
    printConfigResult(r);

    if (r.action === "already-configured") {
      console.log(dim(`\n  No changes needed — knol-local is already in the config.`));
    } else if (r.action === "added" || r.action === "created" || r.action === "updated") {
      const restartNote = target === "claude"
        ? "Restart Claude Desktop to load the new MCP server."
        : "Restart Cursor to load the new MCP server.";
      console.log(`\n  ${restartNote}`);
    } else if (r.action === "error") {
      console.log(`\n  ${dim("You can add the entry manually:")}`);
      console.log(JSON.stringify({ mcpServers: { "knol-local": { command: "knol-local" } } }, null, 2));
    }
    console.log();
    return;
  }

  // ── no target: auto-detect and configure all ─────────────────────────────
  console.log(bold("\nAuto-configuring MCP clients…\n"));
  const results = autoSetupMcpConfigs();
  for (const r of results) printConfigResult(r);

  const changed = results.filter(r => r.action === "added" || r.action === "updated" || r.action === "created");
  const skipped = results.filter(r => r.action === "skipped");

  if (changed.length > 0) {
    console.log(`\n  ${green("Done.")} Restart the configured app(s) to activate knol-local.`);
  } else if (skipped.length === results.length) {
    // No config files found at all
    console.log(`\n  ${dim("No existing config files found.")} Run one of:`);
    console.log(cyan("    knol-local setup claude      # Claude Desktop"));
    console.log(cyan("    knol-local setup cursor      # Cursor"));
    console.log(cyan("    knol-local setup claude-code # Claude Code CLI"));
    console.log(cyan("    knol-local setup codex       # Codex / HTTP API"));
  } else {
    console.log(`\n  ${dim("All found configs are already up to date.")}`);
  }

  // Always show the config paths so the user can verify
  console.log();
  console.log(dim("  Config file locations searched:"));
  console.log(dim(`    Claude Desktop : ${claudeDesktopConfigPath()}`));
  console.log(dim(`    Cursor         : ${cursorConfigPath()}`));
  console.log();
}

function cmdServe(store: MemoryStore, args: string[]): void {
  const { flags } = parseArgs(args);
  const port = flags["port"] ? parseInt(flags["port"], 10) : 3001;
  const apiKey = flags["key"];
  startHttpServer(store, { port, apiKey });
  console.log(green(`HTTP server listening on port ${port}`));
  if (apiKey) {
    console.log(dim(`  Auth: Bearer token required`));
  }
}

function cmdHelp(): void {
  console.log(`
${bold("knol-local")} — local memory for AI assistants

${bold("Usage:")}
  knol-local [--mcp]                          Start MCP server (default)
  knol-local <command> [options]
  knol-local --help | -h                      Show this help

${bold("Commands:")}
  list   [--tag <tag>] [--limit <n>]          List stored memories
  add    <content> [--tag t1,t2]              Add a memory
         [--importance 0.0-1.0]
  search <query> [--limit <n>]                Full-text search
         [--tag t1,t2]
  stats                                       Show summary statistics
  export [--out <file>]                       Export all memories as JSON
  import <file>                               Import memories from JSON
  backup [--out <dir>]                        Backup database file
  restore <file>                              Restore database from backup
  setup  [claude|cursor|claude-code|codex]    Auto-configure MCP clients
  serve  [--port 3001] [--key <apikey>]       Start HTTP REST server
  help                                        Show this help

${bold("MCP client setup:")}
  knol-local setup                            Auto-detect Claude Desktop & Cursor
  knol-local setup claude                     Claude Desktop
  knol-local setup cursor                     Cursor
  knol-local setup claude-code                Claude Code CLI
  knol-local setup codex                      Codex / HTTP API instructions

${bold("Environment:")}
  KNOL_LOCAL_DB   Override the database path (default: ~/.knol-local/memories.db)

${bold("Note:")}
  Claude Desktop uses a restricted PATH. Run ${cyan("knol-local setup claude")} to
  write the absolute node path into the config so it can find the server.
`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runCli(args: string[], store: MemoryStore): Promise<void> {
  // Support: knol-local --help / knol-local -h
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "-help") {
    cmdHelp();
    return;
  }

  const [sub, ...rest] = args;

  // Support: knol-local <cmd> --help
  if (rest[0] === "--help" || rest[0] === "-h") {
    cmdHelp();
    return;
  }

  switch (sub) {
    case "list":    cmdList(store, rest); break;
    case "add":     cmdAdd(store, rest); break;
    case "search":  cmdSearch(store, rest); break;
    case "stats":   cmdStats(store); break;
    case "export":  cmdExport(store, rest); break;
    case "import":  cmdImport(store, rest); break;
    case "backup":  await cmdBackup(store, rest); break;
    case "restore": await cmdRestore(store, rest); break;
    case "setup":   cmdSetup(rest); break;
    case "serve":   cmdServe(store, rest); break;
    case "help":
    default:        cmdHelp(); break;
  }
}
