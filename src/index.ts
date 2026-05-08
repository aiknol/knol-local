#!/usr/bin/env node

// Suppress Node.js experimental warning for node:sqlite on Node 22.x
// Must happen before any module that imports node:sqlite is loaded.
// Static ESM imports are hoisted, so we use dynamic imports below.
const _warn = process.emitWarning.bind(process);
(process as NodeJS.Process).emitWarning = (
  warning: string | Error,
  ...args: unknown[]
) => {
  const msg = typeof warning === "string" ? warning : (warning as Error).message ?? "";
  if (msg.includes("SQLite")) return;
  (_warn as (...a: unknown[]) => void)(warning, ...args);
};

// Dynamic imports ensure the emitWarning patch is active before node:sqlite loads
const { MemoryStore } = await import("./store.js");
const { runCli }      = await import("./cli.js");
const { startMcpServer } = await import("./mcp.js");

// ── Dispatch ────────────────────────────────────────────────────────────────

const CLI_COMMANDS = new Set([
  "list", "add", "search", "stats", "export", "import",
  "backup", "restore", "setup", "serve", "help",
]);

const args  = process.argv.slice(2);
const first = args[0] ?? "";

if (first === "--mcp" || first === "" || !CLI_COMMANDS.has(first)) {
  // MCP mode — backward compatible default
  await startMcpServer();
} else {
  // CLI mode
  const dbPath = process.env["KNOL_LOCAL_DB"];
  const store  = new MemoryStore(dbPath);
  try {
    await runCli(args, store);
  } finally {
    if (first !== "serve") store.close();
  }
}
