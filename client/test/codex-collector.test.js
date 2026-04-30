#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  chooseCodexModel,
  collectCodexUsageData,
  findCodexRolloutFiles,
  parseCodexUsageLine
} from '../hooks/shared/codex-collector.js';

const tempDir = await mkdtemp(path.join(tmpdir(), 'codex-collector-'));

try {
  const sessionsDir = path.join(tempDir, 'sessions');
  const dayDir = path.join(sessionsDir, '2026', '04', '28');
  await mkdir(dayDir, { recursive: true });

  const sessionMeta = {
    timestamp: '2026-04-28T01:49:52.357Z',
    type: 'session_meta',
    payload: {
      id: 'thread-1',
      model_provider: 'openai'
    }
  };

  const tokenEvent = {
    timestamp: '2026-04-28T01:52:36.863Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 125
        },
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 125
        }
      }
    }
  };

  const ignoredEvent = {
    timestamp: '2026-04-28T01:53:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      content: 'should not be parsed as usage'
    }
  };

  const rolloutPath = path.join(dayDir, 'rollout-2026-04-28T09-46-35-thread-1.jsonl');
  await writeFile(
    rolloutPath,
    [sessionMeta, ignoredEvent, tokenEvent, tokenEvent].map(item => JSON.stringify(item)).join('\n')
  );

  const files = await findCodexRolloutFiles(sessionsDir);
  assert.deepEqual(files, [rolloutPath]);

  const parsedMeta = parseCodexUsageLine(JSON.stringify(sessionMeta));
  assert.equal(parsedMeta.sessionMeta.id, 'thread-1');
  assert.equal(parsedMeta.usage, null);

  assert.equal(chooseCodexModel({ model_provider: 'openai' }, { model: 'gpt-5.5' }), 'gpt-5.5');
  assert.equal(chooseCodexModel({ model_provider: 'openai' }, {}), 'openai');

  const entries = await collectCodexUsageData({}, {
    sessionsDir,
    threadMetadata: {
      byId: {
        'thread-1': {
          model: 'gpt-5.5',
          model_provider: 'openai'
        }
      },
      byRolloutPath: {}
    }
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].timestamp, tokenEvent.timestamp);
  assert.deepEqual(entries[0].tokens, {
    input: 100,
    output: 25,
    cache_creation: 0,
    cache_read: 30
  });
  assert.equal(entries[0].model, 'gpt-5.5');
  assert.equal(entries[0].session_id, 'thread-1');
  assert.equal(entries[0].source, 'codex');
  assert.equal(typeof entries[0].interaction_hash, 'string');

  const dayKey = entries[0].timestamp.split('T')[0];
  const deduped = await collectCodexUsageData({
    recentHashes: {
      [dayKey]: [entries[0].interaction_hash]
    }
  }, { sessionsDir });
  assert.equal(deduped.length, 0);

  console.log('codex-collector tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
