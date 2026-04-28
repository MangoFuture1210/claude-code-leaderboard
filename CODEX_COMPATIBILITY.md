# Codex Compatibility Investigation

## Summary

The current project can support Codex with a small adapter layer. The server already accepts generic usage records shaped as timestamp + token counts + model + session id + interaction hash. Most Claude-specific behavior lives in the client installer and collector.

The main work is to add a Codex collector that reads Codex local usage metadata and emits the existing `/api/usage/submit` payload. A server rewrite is not required for an MVP.

## Current Claude Flow

```text
Claude Code Stop Hook
  -> ~/.claude/claude_stats_hook.js
  -> scan Claude JSONL files under ~/.claude/projects or $XDG_CONFIG_HOME/claude/projects
  -> parse message.usage
  -> POST /api/usage/submit
  -> SQLite + dashboard
```

Key files:

- `client/src/utils/hook-manager.js`: installs the Claude Stop hook into `~/.claude/settings.json`.
- `client/hooks/count_tokens_v4.js`: throttling, locking, buffering, and upload logic.
- `client/hooks/shared/data-collector.js`: Claude JSONL discovery and parsing.
- `server/routes/usage.js`: generic ingestion endpoint.
- `server/db/database.js`: generic token usage schema.

## Codex Local Signals

Observed local Codex state on this machine:

- `~/.codex/state_5.sqlite`
  - `threads` table includes `id`, `rollout_path`, `created_at`, `updated_at`, `source`, `model_provider`, `model`, `reasoning_effort`, `cwd`, and `tokens_used`.
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - Contains `event_msg` entries where `payload.type === "token_count"`.
  - These include `info.last_token_usage` and `info.total_token_usage` with:
    - `input_tokens`
    - `cached_input_tokens`
    - `output_tokens`
    - `reasoning_output_tokens`
    - `total_tokens`

This means Codex compatibility can use reported token counts rather than estimating tokens from text.

## Recommended MVP

Add a Codex import/drain command instead of trying to install a Codex hook first. The initial implementation provides manual sync:

```bash
claude-stats codex sync
```

The first version should:

1. Store shared tracking config in a neutral location such as `~/.ai-usage-stats/stats-config.json`, while continuing to read existing `~/.claude/stats-config.json` for backward compatibility.
2. Read `~/.codex/state_5.sqlite` to discover threads, model, timestamps, and rollout paths.
3. Read rollout JSONL files incrementally, extracting only `payload.type === "token_count"` events.
4. Convert `last_token_usage` into one usage record per event.
5. Send records to the existing `/api/usage/submit` endpoint.

Auto-sync can now use Codex's official Stop Hook mechanism. The client should install a user-level hook in `~/.codex/hooks.json` and enable `[features].codex_hooks = true` in `~/.codex/config.toml`.

Suggested mapping:

```js
{
  timestamp: event.timestamp,
  tokens: {
    input: usage.input_tokens || 0,
    output: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0),
    cache_creation: 0,
    cache_read: usage.cached_input_tokens || 0
  },
  model: thread.model || "codex",
  session_id: thread.id,
  interaction_hash: sha256(`${thread.id}:${event.timestamp}:${usage.total_tokens}`)
}
```

Using `last_token_usage` avoids double-counting. `total_token_usage` is cumulative within the thread and is useful for validation/debugging, not insertion.

## Product Naming

The CLI and UI are currently Claude-branded. A Codex-compatible version should likely introduce neutral naming without breaking existing users:

- Keep `claude-stats` as an alias.
- Add a neutral binary such as `ai-usage-stats` or `model-stats`.
- Rename dashboard text from "Claude Code 使用统计" to a provider-neutral label.
- Add a provider/source dimension later if Claude and Codex should be compared separately.

## Server Changes

MVP server changes are optional. The existing schema is already generic enough for Codex records.

Useful follow-up improvements:

- Add `provider` or `source` column to `usage_records`, defaulting to `claude`.
- Add OpenAI/Codex model pricing support in `server/utils/pricing.js`.
- Update `/api/usage/info` supported model metadata so it does not imply Claude-only support.
- Consider adding `reasoning_output_tokens` as a first-class column if the dashboard should break it out separately.

## Risks And Unknowns

- Codex local storage is implementation detail. `state_5.sqlite` and rollout JSONL are available today, but a future Codex release may rename files or fields.
- Rollout JSONL may contain sensitive conversation/tool content, so the collector must parse only token-count metadata and avoid logging raw lines.
- `threads.tokens_used` appears useful for summaries, but event-level `last_token_usage` gives better incremental records.
- Codex may emit multiple token-count events per user turn or model request. Deduplication should be based on event identity/hash, not only session id.

## Implementation Plan

1. Extract shared upload, lock, state, buffer, and JSONL-offset helpers from `count_tokens_v4.js` into reusable modules.
2. Add `client/hooks/shared/codex-collector.js`.
3. Add CLI commands under a `codex` command group.
4. Keep Claude hook installation untouched.
5. Add fixture tests for parsing Codex token-count JSONL without storing conversation content.
6. Add Codex Stop Hook install/status/uninstall commands for automatic sync after each Codex turn.
