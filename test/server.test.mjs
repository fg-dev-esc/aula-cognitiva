import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleChat,
  learningRecordsFromState,
  learningStateFromRecords,
  parseEvaluationResponse,
  validateLearningPayload,
} from '../scripts/server.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('chat forwards provider rate limits with a 70 second retry window', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'rate limit' },
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const response = responseRecorder();
    await handleChat({
      method: 'POST',
      body: {
        provider: 'groq',
        model: 'test-model',
        harness: 'normal',
        messages: [{ role: 'user', content: 'hola' }],
      },
    }, response);

    assert.equal(response.status, 429);
    assert.equal(response.headers['Retry-After'], '70');
    assert.deepEqual(JSON.parse(response.body), {
      error: 'rate limit',
      retryAfterSeconds: 70,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
});

test('chat also forwards a plain-text provider rate limit', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response('try again later', { status: 429 });

  try {
    const response = responseRecorder();
    await handleChat({
      method: 'POST',
      body: {
        provider: 'groq',
        model: 'test-model',
        harness: 'normal',
        messages: [{ role: 'user', content: 'hola' }],
      },
    }, response);
    assert.equal(response.status, 429);
    assert.equal(JSON.parse(response.body).retryAfterSeconds, 70);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
});

test('learning payload metadata must match its state', () => {
  const state = {
    schemaVersion: 1,
    settings: {
      trackId: 'track',
      trackVersion: 1,
      selectedLevelId: 'nivel-0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    lessonRuns: [],
    skillProgress: {},
    reviewQueue: [],
    currentRunId: null,
  };
  assert.doesNotThrow(() => validateLearningPayload({
    revision: 0,
    trackId: 'track',
    trackVersion: 1,
    selectedLevelId: 'nivel-0',
    state,
  }));
  assert.throws(() => validateLearningPayload({
    revision: 0,
    trackId: 'other',
    trackVersion: 1,
    selectedLevelId: 'nivel-0',
    state,
  }), /no coinciden/);
});

test('learning state is stored as independent records and rebuilt without deleted runs', () => {
  const settings = {
    trackId: 'track',
    trackVersion: 1,
    selectedLevelId: 'nivel-0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const run = { id: 'run-1', lessonId: 'lesson-1', status: 'in_progress' };
  const review = { id: 'review-1', lessonId: 'lesson-1', status: 'pending' };
  const state = {
    schemaVersion: 1,
    settings,
    lessonRuns: [run],
    skillProgress: { arrays: { score: 80 } },
    reviewQueue: [review],
    currentRunId: run.id,
  };
  const records = learningRecordsFromState(state);

  assert.deepEqual(records.map(record => record.record_type), ['run', 'skill', 'review']);
  assert.deepEqual(learningStateFromRecords({
    schema_version: 1,
    current_run_id: run.id,
    settings,
  }, records), state);

  const withoutRun = learningStateFromRecords({
    schema_version: 1,
    current_run_id: run.id,
    settings,
  }, records.filter(record => record.record_type !== 'run'));
  assert.deepEqual(withoutRun.lessonRuns, []);
  assert.equal(withoutRun.currentRunId, null);
});

test('evaluation evidence is restricted to the lesson skills', () => {
  const raw = JSON.stringify({
    verdict: 'passed',
    score: 90,
    criticalChecksPassed: true,
    feedback: 'Correcto.',
    skillEvidence: [{ skillId: 'filter-simple', score: 90 }],
    nextAction: 'complete',
  });
  assert.equal(parseEvaluationResponse(raw, 80, ['filter-simple']).score, 90);
  assert.throws(() => parseEvaluationResponse(raw, 80, ['otra-habilidad']), /no coincide/);
});
