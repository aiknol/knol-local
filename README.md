# knol-local

A lightweight, fully local memory layer for AI assistants — Claude, Cursor, and Codex.  
Stores memories in a SQLite database on your machine. No cloud, no accounts, no API keys.

```bash
npm install -g knol-local
```

---

## Features

- **Persistent memory** across sessions — memories survive restarts
- **Full-text search** via SQLite FTS5 with Porter stemming (`running` matches `run`, `ran`)
- **BM25 ranking** weighted by per-memory importance scores
- **Tags** for organising and filtering memories
- **MCP server** — native integration with Claude Desktop, Claude Code, and Cursor
- **HTTP REST API** — connects any tool that doesn't support MCP (Codex, ChatGPT, scripts)
- **CLI** — manage memories, backup, restore, and export from the terminal
- **Zero cloud** — everything lives in `~/.knol-local/memories.db`
- **Tiny footprint** — two runtime deps: `better-sqlite3` + MCP SDK

---

## Quick start

```bash
npm install -g knol-local

# Add a memory
knol-local add "I prefer TypeScript strict mode" --tag preference --importance 0.9

# Search memories
knol-local search "TypeScript"

# List all memories
knol-local list

# Get setup instructions for your AI tool
knol-local setup claude
knol-local setup cursor
knol-local setup codex
```

---

## Connecting to Claude

### Claude Desktop

Run the setup command to get the exact config path and snippet:

```bash
knol-local setup claude
```

Or manually edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) /
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "knol-local": {
      "command": "knol-local"
    }
  }
}
```

Restart Claude Desktop. The 6 memory tools will appear automatically.

### Claude Code (CLI)

```bash
claude mcp add knol-local knol-local
```

### Cursor

Run the setup command:

```bash
knol-local setup cursor
```

Or manually edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "knol-local": {
      "command": "knol-local"
    }
  }
}
```

Restart Cursor after saving.

### Codex / ChatGPT (HTTP API)

Codex doesn't support MCP. Use the built-in HTTP server instead:

```bash
# Start the HTTP server
knol-local serve --port 3001

# Optional: protect with a Bearer token
knol-local serve --port 3001 --key mysecret
```

Then point Codex at `http://localhost:3001`. See [HTTP API](#http-api) below.

---

## MCP tools (Claude & Cursor)

Six tools are exposed over the Model Context Protocol:

| Tool | Description |
|------|-------------|
| `remember` | Save a memory — content, tags, importance, metadata |
| `recall` | Full-text search, ranked by relevance × importance |
| `forget` | Delete a memory by ID |
| `update_memory` | Edit content, tags, or importance |
| `list_memories` | Browse recently updated memories |
| `memory_stats` | Total count, oldest/newest timestamps |

Usage examples in Claude:

> "Remember that I prefer dark mode in all editors."  
> "What do you know about my project preferences?"  
> "Forget the memory about my old API key."

---

## CLI reference

```
knol-local [--mcp]                          Start MCP server (default)
knol-local <command> [options]
```

| Command | Description |
|---------|-------------|
| `add <content> [--tag t1,t2] [--importance 0.9]` | Add a memory |
| `search <query> [--limit n] [--tag t1,t2]` | Full-text search |
| `list [--tag <tag>] [--limit n]` | List memories, newest first |
| `stats` | Total count, oldest/newest dates |
| `export [--out file.json]` | Export all memories as JSON |
| `import <file.json>` | Import memories from a JSON file |
| `backup [--out <dir>]` | Copy the database to a timestamped backup |
| `restore <file>` | Restore the database from a backup (with confirmation) |
| `setup <claude\|cursor\|codex> [--http-port n]` | Print setup instructions |
| `serve [--port 3001] [--key <token>]` | Start HTTP REST server |
| `help` | Show usage |

---

## HTTP API

Start the server:

```bash
knol-local serve --port 3001
```

With optional Bearer token auth:

```bash
knol-local serve --port 3001 --key mysecret
# All requests (except /health) must include:
# Authorization: Bearer mysecret
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — always public |
| `GET` | `/memories` | List memories (`?limit=20&tags=x,y`) |
| `POST` | `/memories` | Add a memory (`{content, tags?, importance?, metadata?}`) |
| `GET` | `/memories/search` | Search (`?q=query&limit=10&tags=x,y`) |
| `GET` | `/memories/stats` | Total count and date range |
| `GET` | `/memories/:id` | Get a memory by ID |
| `PATCH` | `/memories/:id` | Update fields (`{content?, tags?, importance?}`) |
| `DELETE` | `/memories/:id` | Delete a memory |
| `GET` | `/export` | Export all memories as JSON |
| `POST` | `/import` | Bulk import (`{memories: [...]}`) |

### Examples

```bash
# Add a memory
curl -X POST http://localhost:3001/memories \
  -H "Content-Type: application/json" \
  -d '{"content":"Prefer tabs over spaces","tags":["preference"],"importance":0.8}'

# Search
curl "http://localhost:3001/memories/search?q=tabs"

# Export
curl http://localhost:3001/export > backup.json

# Import
curl -X POST http://localhost:3001/import \
  -H "Content-Type: application/json" \
  -d @backup.json
```

---

## Backup & restore

```bash
# Create a timestamped backup in ~/.knol-local/backups/
knol-local backup

# Backup to a custom directory (e.g. Dropbox)
knol-local backup --out ~/Dropbox/knol-backups/

# Export as portable JSON (works across machines)
knol-local export --out ~/memories.json

# Import on another machine
knol-local import ~/memories.json

# Restore from a .db backup (prompts for confirmation)
knol-local restore ~/.knol-local/backups/memories-2026-05-08T12-00-00.db
```

---

## Sharing memories between tools

All tools (Claude, Cursor, Codex) read and write the **same database file** at `~/.knol-local/memories.db`. A memory saved from Claude is immediately available in Cursor and vice versa.

To use a project-specific database, set `KNOL_LOCAL_DB`:

```json
{
  "mcpServers": {
    "knol-local": {
      "command": "knol-local",
      "env": { "KNOL_LOCAL_DB": "/path/to/project/.memory.db" }
    }
  }
}
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `KNOL_LOCAL_DB` | `~/.knol-local/memories.db` | Path to the SQLite database |

---

## Database location

```
~/.knol-local/
├── memories.db          # SQLite database (WAL mode)
└── backups/
    └── memories-TIMESTAMP.db
```

---

## Development

```bash
git clone https://github.com/aiknol/knol-local
cd knol-local
npm install
npm run build       # compile TypeScript
node test/run.mjs   # run integration tests (38 assertions)
npm start           # start MCP server
```

---

## License

MIT
