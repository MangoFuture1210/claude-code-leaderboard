#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const CODEX_HOME_ENV = 'CODEX_HOME';
const CODEX_SESSIONS_DIR = 'sessions';

function getCodexDir() {
  return process.env[CODEX_HOME_ENV] || path.join(homedir(), '.codex');
}

function getCodexSessionsDir(codexDir = getCodexDir()) {
  return path.join(codexDir, CODEX_SESSIONS_DIR);
}

async function findCodexRolloutFiles(dir = getCodexSessionsDir()) {
  const files = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...await findCodexRolloutFiles(fullPath));
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Missing Codex sessions are expected on machines without Codex usage.
  }

  return files.sort();
}

function mapCodexTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  const reasoningTokens = Number(usage.reasoning_output_tokens) || 0;
  const cachedInputTokens = Number(usage.cached_input_tokens) || 0;

  if (inputTokens + outputTokens + reasoningTokens + cachedInputTokens === 0) {
    return null;
  }

  return {
    input: inputTokens,
    output: outputTokens + reasoningTokens,
    cache_creation: 0,
    cache_read: cachedInputTokens
  };
}

function buildInteractionHash(sessionId, timestamp, usage) {
  const hashInput = JSON.stringify({
    sessionId,
    timestamp,
    input: usage.input_tokens || 0,
    cached: usage.cached_input_tokens || 0,
    output: usage.output_tokens || 0,
    reasoning: usage.reasoning_output_tokens || 0,
    total: usage.total_tokens || 0
  });

  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

function parseCodexUsageLine(line, sessionMeta = {}) {
  try {
    const event = JSON.parse(line.trim());
    if (event?.type === 'session_meta') {
      return { sessionMeta: event.payload || {}, usage: null };
    }

    if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') {
      return { sessionMeta: null, usage: null };
    }

    const timestamp = event.timestamp;
    const lastUsage = event.payload?.info?.last_token_usage;
    const tokens = mapCodexTokenUsage(lastUsage);

    if (!timestamp || !lastUsage || !tokens) {
      return { sessionMeta: null, usage: null };
    }

    const sessionId = sessionMeta.id || event.payload?.thread_id || null;

    return {
      sessionMeta: null,
      usage: {
        timestamp,
        tokens,
        model: sessionMeta.model || sessionMeta.model_provider || 'codex',
        session_id: sessionId,
        interaction_hash: buildInteractionHash(sessionId, timestamp, lastUsage),
        source: 'codex'
      }
    };
  } catch {
    return { sessionMeta: null, usage: null };
  }
}

async function parseCodexRolloutFile(filePath, state = {}, logger = null, seenHashes = new Set()) {
  const entries = [];
  let sessionMeta = {};

  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);

    for (const line of lines) {
      const parsed = parseCodexUsageLine(line, sessionMeta);

      if (parsed.sessionMeta) {
        sessionMeta = { ...sessionMeta, ...parsed.sessionMeta };
        continue;
      }

      if (!parsed.usage) continue;

      const dayKey = parsed.usage.timestamp.split('T')[0];
      if (state.recentHashes?.[dayKey]?.includes(parsed.usage.interaction_hash)) {
        continue;
      }

      if (seenHashes.has(parsed.usage.interaction_hash)) {
        continue;
      }

      seenHashes.add(parsed.usage.interaction_hash);
      entries.push(parsed.usage);
    }

    if (entries.length > 0 && logger) {
      await logger.log('debug', 'Parsed Codex rollout file', {
        file: path.basename(filePath),
        validEntries: entries.length
      });
    }
  } catch (error) {
    if (logger) {
      await logger.log('warn', 'Failed to parse Codex rollout file', {
        file: filePath,
        error: error.message
      });
    }
  }

  return entries;
}

async function collectCodexUsageData(state = {}, options = {}, logger = null) {
  const sessionsDir = options.sessionsDir || getCodexSessionsDir(options.codexDir);

  if (!existsSync(sessionsDir)) {
    if (logger) await logger.log('warn', 'No Codex sessions directory found');
    return [];
  }

  const files = await findCodexRolloutFiles(sessionsDir);
  const allEntries = [];
  const seenHashes = new Set();

  for (const file of files) {
    const entries = await parseCodexRolloutFile(file, state, logger, seenHashes);
    allEntries.push(...entries);
  }

  return allEntries;
}

export {
  getCodexDir,
  getCodexSessionsDir,
  findCodexRolloutFiles,
  mapCodexTokenUsage,
  parseCodexUsageLine,
  parseCodexRolloutFile,
  collectCodexUsageData
};
