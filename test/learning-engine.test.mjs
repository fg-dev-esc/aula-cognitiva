import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as engine from '../scripts/learning-engine.mjs';
import { mergeLearningContent } from '../scripts/learning-content.mjs';

const {
  LEARNING_SCHEMA_VERSION,
  appendLessonMessage,
  createInitialLearningState,
  getChronology,
  getLearningSummary,
  recordEvaluation,
  revealHint,
  revealSolution,
  selectNextLesson,
  startLessonRun,
  submitAttempt,
  validateLearningState,
} = engine;

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

const [baseCurriculum, baseSupport, advancedConsole, projectCourses] = await Promise.all([
  readJson('../learning/curriculum.json'),
  readJson('../learning/support.json'),
  readJson('../learning/advanced-console.json'),
  readJson('../learning/project-courses.json'),
]);
const { curriculum } = mergeLearningContent(baseCurriculum, baseSupport, [
  advancedConsole,
  projectCourses,
]);
const baseTime = '2026-07-20T09:00:00.000Z';

function initial(selectedLevelId = 'nivel-0') {
  return createInitialLearningState({
    trackId: curriculum.routeId,
    trackVersion: curriculum.schemaVersion,
    selectedLevelId,
    now: '2026-07-20T08:00:00.000Z',
  });
}

function evaluation(skillId, options = {}) {
  const verdict = options.verdict ?? 'passed';
  return {
    verdict,
    score: options.score ?? (verdict === 'passed' ? 90 : 60),
    criticalChecksPassed: options.criticalChecksPassed ?? true,
    feedback: options.feedback ?? (verdict === 'passed' ? 'Buen trabajo.' : 'Revisa la solucion.'),
    skillEvidence: [{ skillId, score: options.skillScore ?? options.score ?? 90 }],
    nextAction: verdict === 'passed' ? 'complete' : 'retry',
  };
}

function start(state, input, id, now = baseTime, extra = {}) {
  return startLessonRun(state, input, {
    id,
    now,
    dateKey: now.slice(0, 10),
    ...extra,
  });
}

function submit(state, runId, attemptId, now = baseTime) {
  return submitAttempt(
    state,
    runId,
    { prediction: 'resultado', code: 'console.log(resultado)' },
    { id: attemptId, messageId: `user-${attemptId}`, now },
  );
}

function completeSelection(state, selection, index, now = baseTime, score = 90) {
  const runId = `run-${index}`;
  const attemptId = `attempt-${index}`;
  let next = start(state, selection, runId, now);
  next = submit(next, runId, attemptId, now);
  return recordEvaluation(
    next,
    runId,
    attemptId,
    evaluation(selection.lesson.primarySkills[0], { score }),
    { id: `assistant-${attemptId}`, now },
  );
}

test('exports only the MVP API and creates a minimal valid state', () => {
  assert.deepEqual(Object.keys(engine).sort(), [
    'LEARNING_SCHEMA_VERSION',
    'appendLessonMessage',
    'createInitialLearningState',
    'getChronology',
    'getLearningSummary',
    'recordEvaluation',
    'revealHint',
    'revealSolution',
    'selectNextLesson',
    'startLessonRun',
    'submitAttempt',
    'validateLearningState',
  ]);

  const state = initial();
  assert.equal(LEARNING_SCHEMA_VERSION, 1);
  assert.deepEqual(state, {
    schemaVersion: 1,
    settings: {
      trackId: 'js-arrays-console-v1',
      trackVersion: 1,
      selectedLevelId: 'nivel-0',
      createdAt: '2026-07-20T08:00:00.000Z',
      updatedAt: '2026-07-20T08:00:00.000Z',
    },
    lessonRuns: [],
    skillProgress: {},
    reviewQueue: [],
    currentRunId: null,
  });
  assert.deepEqual(validateLearningState(state), { valid: true, errors: [] });
  assert.equal(validateLearningState(null).valid, false);
  assert.doesNotThrow(() => validateLearningState({ schemaVersion: 99 }));

  const circular = { schemaVersion: 1 };
  circular.self = circular;
  assert.equal(validateLearningState(circular).valid, false);
  assert.doesNotThrow(() => JSON.stringify(state));
});

test('loads the real curriculum and advances from nivel-0 into nivel-1', () => {
  assert.equal(curriculum.schemaVersion, 1);
  assert.equal(curriculum.routeId, 'js-arrays-console-v1');
  assert.equal(curriculum.lessons.length, 53);

  let state = initial();
  const levelZeroIds = curriculum.levels[0].lessonIds;
  for (const [index, expectedId] of levelZeroIds.entries()) {
    const selection = selectNextLesson(curriculum, state, { skipReviews: true, now: baseTime });
    assert.equal(selection.lesson.id, expectedId);
    assert.equal(selection.kind, expectedId.endsWith('checkpoint') ? 'checkpoint' : 'lesson');
    state = completeSelection(state, selection, index + 1);
  }

  const nextLevel = selectNextLesson(curriculum, state, { skipReviews: true, now: baseTime });
  assert.equal(nextLevel.lesson.id, curriculum.levels[1].lessonIds[0]);
  assert.equal(nextLevel.levelId, 'nivel-1');
  assert.deepEqual(
    state.lessonRuns.map((run) => run.dailyOrder),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    state.lessonRuns.map((run) => run.previousRunId),
    [null, 'run-1', 'run-2', 'run-3', 'run-4'],
  );
  assert.deepEqual(validateLearningState(state), { valid: true, errors: [] });
});

test('manual level is the starting level and an active run resumes first', () => {
  const state = initial('nivel-1');
  const selection = selectNextLesson(curriculum, state, { now: baseTime });
  assert.equal(selection.lesson.id, 'l01-filter-simple');

  const ids = ['factory-run'];
  const started = startLessonRun(state, selection, {
    idFactory: () => ids.shift(),
    now: baseTime,
  });
  const resumed = selectNextLesson(curriculum, started, { now: '2026-08-01T00:00:00.000Z' });
  assert.equal(resumed.kind, 'resume');
  assert.equal(resumed.runId, 'factory-run');
  assert.equal(started.lessonRuns[0].maxHintLevel, 3);
  assert.deepEqual(started.lessonRuns[0].skillIds, ['filter-simple']);
  assert.deepEqual(Object.keys(started.lessonRuns[0].lessonSnapshot).sort(), [
    'id',
    'lessonType',
    'levelId',
    'order',
    'primarySkills',
    'reviewIntervals',
    'title',
  ]);
  assert.equal('starterCode' in started.lessonRuns[0].lessonSnapshot, false);
  assert.equal('task' in started.lessonRuns[0].lessonSnapshot, false);
});

test('a project lesson keeps a complete multi-file submission without copying starters to state', () => {
  const state = initial('nivel-7');
  const selection = selectNextLesson(curriculum, state, { skipReviews: true, now: baseTime });
  assert.equal(selection.lesson.id, 'l08-semantica-vite');
  assert.equal(selection.lesson.modality, 'project_files');

  let next = start(state, selection, 'project-run');
  const submission = '<!doctype html>\n...\n\nimport "./styles.css";\n\nbody { margin: 0; }';
  next = submitAttempt(next, 'project-run', submission, {
    id: 'project-attempt',
    messageId: 'project-message',
    now: baseTime,
  });

  assert.equal(next.lessonRuns[0].attempts[0].submission, submission);
  assert.equal('starterFiles' in next.lessonRuns[0].lessonSnapshot, false);
  assert.equal('submissionFiles' in next.lessonRuns[0].lessonSnapshot, false);
  assert.deepEqual(validateLearningState(next), { valid: true, errors: [] });
});

test('messages and submissions append immutably before evaluation', () => {
  const selection = selectNextLesson(curriculum, initial(), { now: baseTime });
  let state = start(initial(), selection, 'message-run');
  const beforeMessage = state;
  state = appendLessonMessage(state, 'message-run', {
    id: 'instruction',
    timestamp: '2026-07-20T09:01:00.000Z',
    type: 'instruction',
    role: 'assistant',
    content: 'Completa el ejercicio.',
  });
  const beforeSubmit = state;
  state = submit(state, 'message-run', 'message-attempt', '2026-07-20T09:02:00.000Z');

  assert.equal(beforeMessage.lessonRuns[0].messages.length, 0);
  assert.equal(beforeSubmit.lessonRuns[0].attempts.length, 0);
  assert.equal(state.lessonRuns[0].attempts[0].status, 'evaluation_pending');
  assert.equal(state.lessonRuns[0].phase, 'evaluation_pending');
  assert.deepEqual(
    state.lessonRuns[0].messages.map((message) => [message.id, message.role]),
    [
      ['instruction', 'assistant'],
      ['user-message-attempt', 'user'],
    ],
  );
});

test('records the exact server evaluation shape and assistant feedback', () => {
  const selection = selectNextLesson(curriculum, initial(), { now: baseTime });
  let state = start(initial(), selection, 'passed-run');
  state = submit(state, 'passed-run', 'passed-attempt');
  state = recordEvaluation(
    state,
    'passed-run',
    'passed-attempt',
    evaluation('arrays-de-objetos', { score: 80, feedback: 'Cumple los criterios.' }),
    { id: 'passed-feedback', now: '2026-07-20T09:10:00.000Z' },
  );

  const run = state.lessonRuns[0];
  assert.equal(run.status, 'mastered');
  assert.equal(run.attempts[0].status, 'passed');
  assert.deepEqual(run.messages.at(-1), {
    id: 'passed-feedback',
    timestamp: '2026-07-20T09:10:00.000Z',
    type: 'evaluation',
    role: 'assistant',
    content: 'Cumple los criterios.',
  });
  assert.equal(state.skillProgress['arrays-de-objetos'].status, 'mastered');
  assert.throws(
    () =>
      recordEvaluation(state, 'passed-run', 'passed-attempt', {
        verdict: 'passed',
        score: 90,
        criticalChecksPassed: true,
        feedback: 'Sin evidencia.',
        nextAction: 'complete',
      }),
    /skillEvidence/,
  );
});

test('evaluation_error adds feedback but does not penalize or replace attempts', () => {
  const selection = selectNextLesson(curriculum, initial(), { now: baseTime });
  let state = start(initial(), selection, 'error-run');
  state = submit(state, 'error-run', 'error-attempt-1');
  state = recordEvaluation(
    state,
    'error-run',
    'error-attempt-1',
    { verdict: 'evaluation_error', feedback: 'El proveedor no respondio.' },
    { id: 'error-feedback', now: '2026-07-20T09:05:00.000Z' },
  );

  assert.equal(state.lessonRuns[0].failureCount, 0);
  assert.equal(state.lessonRuns[0].hintLevelUnlocked, 3);
  assert.equal(state.lessonRuns[0].attempts[0].status, 'evaluation_error');
  assert.equal(state.lessonRuns[0].messages.at(-1).content, 'El proveedor no respondio.');

  state = submit(state, 'error-run', 'error-attempt-2', '2026-07-20T09:06:00.000Z');
  assert.deepEqual(
    state.lessonRuns[0].attempts.map((attempt) => attempt.id),
    ['error-attempt-1', 'error-attempt-2'],
  );
});

test('checkpoint threshold, critical checks, and hints follow failed attempts', () => {
  const checkpoint = curriculum.lessons.find((lesson) => lesson.id === 'l00-checkpoint');
  let state = start(initial(), checkpoint, 'checkpoint-run');
  state = revealHint(state, 'checkpoint-run', 1, { now: baseTime });
  assert.throws(() => revealHint(state, 'checkpoint-run', 3), /in order/);

  const failures = [
    { score: 84, criticalChecksPassed: true },
    { score: 100, criticalChecksPassed: false },
    { score: 70, criticalChecksPassed: true },
  ];
  for (const [index, failed] of failures.entries()) {
    const number = index + 1;
    state = submit(state, 'checkpoint-run', `checkpoint-attempt-${number}`);
    state = recordEvaluation(
      state,
      'checkpoint-run',
      `checkpoint-attempt-${number}`,
      evaluation('integracion-nivel-0', {
        verdict: 'needs_revision',
        ...failed,
      }),
      { id: `checkpoint-feedback-${number}`, now: baseTime },
    );
    assert.equal(state.lessonRuns[0].hintLevelUnlocked, 3);
    if (number < 3) state = revealHint(state, 'checkpoint-run', number + 1, { now: baseTime });
  }

  assert.equal(state.lessonRuns[0].phase, 'retry');
  assert.equal(state.lessonRuns[0].hintLevelRevealed, 3);
  state = submit(state, 'checkpoint-run', 'checkpoint-attempt-pass');
  state = recordEvaluation(
    state,
    'checkpoint-run',
    'checkpoint-attempt-pass',
    evaluation('integracion-nivel-0', { score: 85 }),
    { id: 'checkpoint-feedback-pass', now: baseTime },
  );
  assert.equal(state.lessonRuns[0].status, 'mastered');
});

test('a viewed solution produces completed_supported and no reviews', () => {
  const selection = selectNextLesson(curriculum, initial(), { now: baseTime });
  let state = start(initial(), selection, 'solution-run');
  assert.throws(() => revealSolution(state, 'solution-run', { now: baseTime }), /at least 70/);
  state = submit(state, 'solution-run', 'solution-attempt-first');
  state = recordEvaluation(
    state,
    'solution-run',
    'solution-attempt-first',
    evaluation('arrays-de-objetos', { verdict: 'needs_revision', score: 70 }),
    { id: 'solution-feedback-first', now: baseTime },
  );
  state = revealSolution(state, 'solution-run', { now: baseTime });
  state = submit(state, 'solution-run', 'solution-attempt');
  state = recordEvaluation(
    state,
    'solution-run',
    'solution-attempt',
    evaluation('arrays-de-objetos', { score: 100 }),
    { id: 'solution-feedback', now: baseTime },
  );

  assert.equal(state.lessonRuns[0].solutionViewed, true);
  assert.equal(state.lessonRuns[0].status, 'completed_supported');
  assert.equal(state.skillProgress['arrays-de-objetos'].status, 'completed_supported');
  assert.equal(state.reviewQueue.length, 0);
});

test('reviews use lesson intervals, can be skipped, and complete through a review run', () => {
  const selection = selectNextLesson(curriculum, initial(), { now: baseTime });
  let state = completeSelection(initial(), selection, 'review-source', baseTime);

  assert.deepEqual(
    state.reviewQueue.map((review) => [review.id, review.intervalDays]),
    [
      ['review:run-review-source:1', 1],
      ['review:run-review-source:3', 3],
      ['review:run-review-source:7', 7],
    ],
  );
  const due = selectNextLesson(curriculum, state, { now: '2026-07-21T10:00:00.000Z' });
  assert.equal(due.kind, 'review');
  const skipped = selectNextLesson(curriculum, state, {
    now: '2026-07-21T10:00:00.000Z',
    skipReviews: true,
  });
  assert.equal(skipped.lesson.id, 'l00-datos-anidados');

  state = start(state, due, 'review-run', '2026-07-21T10:01:00.000Z');
  state = submit(state, 'review-run', 'review-attempt-1', '2026-07-21T10:02:00.000Z');
  state = recordEvaluation(
    state,
    'review-run',
    'review-attempt-1',
    evaluation('arrays-de-objetos', { verdict: 'needs_revision', score: 70 }),
    { id: 'review-feedback-1', now: '2026-07-21T10:03:00.000Z' },
  );
  assert.equal(state.reviewQueue[0].failureCount, 1);
  assert.equal(state.reviewQueue[0].status, 'in_progress');
  assert.equal(state.skillProgress['arrays-de-objetos'].status, 'needs_review');

  state = submit(state, 'review-run', 'review-attempt-2', '2026-07-21T10:04:00.000Z');
  state = recordEvaluation(
    state,
    'review-run',
    'review-attempt-2',
    evaluation('arrays-de-objetos', { score: 90 }),
    { id: 'review-feedback-2', now: '2026-07-21T10:05:00.000Z' },
  );
  assert.equal(state.lessonRuns.at(-1).status, 'review_completed');
  assert.equal(state.reviewQueue[0].status, 'completed');
  assert.equal(state.skillProgress['arrays-de-objetos'].status, 'mastered');
  assert.equal(state.reviewQueue.length, 3);
});

test('a retry replaces the saved session only when it improves the best result', () => {
  const lesson = curriculum.lessons[0];
  let state = start(initial(), lesson, 'best-run');
  state = submit(state, 'best-run', 'best-attempt');
  state = recordEvaluation(
    state,
    'best-run',
    'best-attempt',
    evaluation(lesson.primarySkills[0], { score: 90 }),
    { id: 'best-feedback', now: baseTime },
  );

  state = start(state, lesson, 'worse-run');
  state = submit(state, 'worse-run', 'worse-attempt');
  state = recordEvaluation(
    state,
    'worse-run',
    'worse-attempt',
    evaluation(lesson.primarySkills[0], { score: 85 }),
    { id: 'worse-feedback', now: baseTime },
  );
  assert.deepEqual(state.lessonRuns.filter(run => run.kind !== 'review').map(run => run.id), ['best-run']);

  state = start(state, lesson, 'better-run');
  state = submit(state, 'better-run', 'better-attempt');
  state = recordEvaluation(
    state,
    'better-run',
    'better-attempt',
    evaluation(lesson.primarySkills[0], { score: 95 }),
    { id: 'better-feedback', now: baseTime },
  );
  assert.deepEqual(state.lessonRuns.filter(run => run.kind !== 'review').map(run => run.id), ['better-run']);
  assert.equal(state.lessonRuns.find(run => run.id === 'better-run').score, 95);
});

test('summary is compact and chronology is grouped without mutating state', () => {
  let state = initial();
  let selection = selectNextLesson(curriculum, state, { skipReviews: true, now: baseTime });
  state = completeSelection(state, selection, 'summary-1', baseTime);
  selection = selectNextLesson(curriculum, state, {
    skipReviews: true,
    now: '2026-07-21T11:00:00.000Z',
  });
  state = completeSelection(
    state,
    selection,
    'summary-2',
    '2026-07-21T11:00:00.000Z',
  );

  const summary = getLearningSummary(curriculum, state, '2026-07-21T12:00:00.000Z');
  assert.deepEqual(summary.counts, {
    totalLessons: 53,
    completedLessons: 2,
    masteredLessons: 2,
    supportedLessons: 0,
  });
  assert.deepEqual(summary.progress, { completed: 2, total: 53, percent: 4 });
  assert.deepEqual(summary.level, { selectedId: 'nivel-0', currentId: 'nivel-0' });
  assert.equal(summary.today.runsStarted, 1);
  assert.equal(summary.today.attemptsSubmitted, 1);
  assert.equal(summary.dueReviews, 1);

  const chronology = getChronology(state);
  assert.deepEqual(
    chronology.map((group) => group.dateKey),
    ['2026-07-21', '2026-07-20'],
  );
  chronology[0].runs[0].id = 'changed';
  assert.notEqual(state.lessonRuns[1].id, 'changed');
});
