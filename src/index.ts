#!/usr/bin/env node

import { MemoryStore } from "./store.js";
import { runCli } from "./cli.js";
import { startMcpServer } from "./mcp.js";

const CLI_COMMANDS = new Set([
  "list", "add", "search", "stats", "export", "import",
  "backup", "restore", "setup", "serve", "help",
]);

const args = process.argv.slice(2);
const first = args[0] ?? "";

if (first === "--mcp" || first === "" || !CLI_COMMANDS.has(first)) {
  // MCP mode — backward compatible
  await startMcpServer();
} else {
  // CLI mode
  const dbPath = process.env["KNOL_LOCAL_DB"];
  const store = new MemoryStore(dbPath);
  try {
    await runCli(args, store);
  } finally {
    // Don't close in serve mode — the server keeps running
    if (first !== "serve") store.close();
  }
}
