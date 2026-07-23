export const LEARNING_SCHEMA_VERSION = 1;

const COMPLETED_STATUSES = new Set(['mastered', 'completed_supported']);
const SOLUTION_UNLOCK_SCORE = 70;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function asIso(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date');
  return date.toISOString();
}

function makeId(explicitId, idFactory, name) {
  const id = explicitId ?? idFactory?.() ?? globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error(`${name} requires id, idFactory, or crypto.randomUUID`);
  return requireText(id, name);
}

function assertState(state) {
  if (
    !isObject(state) ||
    !isObject(state.settings) ||
    !Array.isArray(state.lessonRuns) ||
    !isObject(state.skillProgress) ||
    !Array.isArray(state.reviewQueue)
  ) {
    throw new TypeError('state is not a learning state');
  }
}

function getRun(state, runId) {
  const run = state.lessonRuns.find((candidate) => candidate.id === runId);
  if (!run) throw new RangeError(`Unknown lesson run: ${runId}`);
  return run;
}

function getActiveRun(state) {
  return state.lessonRuns.find(
    (run) => run.id === state.currentRunId && run.status === 'in_progress',
  ) ?? null;
}

function touch(state, now) {
  state.settings.updatedAt = now;
}

function addDays(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function orderedLevels(curriculum) {
  if (!isObject(curriculum) || !Array.isArray(curriculum.levels)) {
    throw new TypeError('curriculum.levels must be an array');
  }
  return curriculum.levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => (a.level.order ?? a.index) - (b.level.order ?? b.index))
    .map(({ level }) => level);
}

function levelLessons(curriculum, level) {
  if (!Array.isArray(curriculum.lessons) || !Array.isArray(level.lessonIds)) {
    throw new TypeError('curriculum lessons and level.lessonIds must be arrays');
  }
  const definitions = new Map(curriculum.lessons.map((lesson) => [lesson.id, lesson]));
  return level.lessonIds
    .map((id, index) => {
      const lesson = definitions.get(id);
      if (!lesson) throw new RangeError(`Unknown curriculum lesson: ${id}`);
      return { lesson, index };
    })
    .sort((a, b) => (a.lesson.order ?? a.index) - (b.lesson.order ?? b.index))
    .map(({ lesson }) => lesson);
}

function curriculumSequence(curriculum, selectedLevelId) {
  const levels = orderedLevels(curriculum);
  const start = levels.findIndex((level) => level.id === selectedLevelId);
  if (start === -1) throw new RangeError(`Unknown selected level: ${selectedLevelId}`);
  return levels.slice(start).flatMap((level) => levelLessons(curriculum, level));
}

function findLesson(curriculum, lessonId) {
  return curriculum.lessons?.find((lesson) => lesson.id === lessonId) ?? null;
}

function isCheckpoint(lesson) {
  return typeof lesson.lessonType === 'string' && lesson.lessonType.includes('checkpoint');
}

function lessonDescriptor(lesson) {
  return {
    kind: isCheckpoint(lesson) ? 'checkpoint' : 'lesson',
    lesson: clone(lesson),
    lessonId: lesson.id,
    levelId: lesson.levelId,
  };
}

function snapshotLesson(lesson) {
  return {
    id: lesson.id,
    levelId: lesson.levelId,
    order: lesson.order ?? null,
    title: lesson.title ?? '',
    lessonType: lesson.lessonType ?? 'guided_practice',
    primarySkills: [...new Set((lesson.primarySkills ?? []).filter(Boolean))],
    reviewIntervals: [
      ...new Set(
        (lesson.reviewIntervals ?? []).filter(
          (days) => Number.isInteger(days) && days > 0,
        ),
      ),
    ],
  };
}

function submissionContent(submission) {
  if (typeof submission === 'string') return submission;
  for (const field of ['content', 'answer', 'code']) {
    if (typeof submission?.[field] === 'string') return submission[field];
  }
  const content = JSON.stringify(submission);
  if (content === undefined) throw new TypeError('submission must be serializable');
  return content;
}

function validateEvaluation(evaluation) {
  if (!isObject(evaluation)) throw new TypeError('evaluation must be an object');
  requireText(evaluation.feedback, 'evaluation.feedback');

  if (evaluation.verdict === 'evaluation_error') {
    if (evaluation.score !== undefined || evaluation.skillEvidence !== undefined
        || evaluation.nextAction !== undefined || evaluation.criticalChecksPassed !== undefined) {
      throw new TypeError('evaluation_error cannot include scores or evidence');
    }
    return;
  }
  if (!['passed', 'needs_revision'].includes(evaluation.verdict)) {
    throw new TypeError('evaluation.verdict is invalid');
  }
  if (!Number.isFinite(evaluation.score) || evaluation.score < 0 || evaluation.score > 100) {
    throw new TypeError('evaluation.score must be between 0 and 100');
  }
  if (typeof evaluation.criticalChecksPassed !== 'boolean') {
    throw new TypeError('evaluation.criticalChecksPassed must be boolean');
  }
  if (!Array.isArray(evaluation.skillEvidence)) {
    throw new TypeError('evaluation.skillEvidence must be an array');
  }
  for (const item of evaluation.skillEvidence) {
    if (
      !isObject(item) ||
      typeof item.skillId !== 'string' ||
      !item.skillId.trim() ||
      !Number.isFinite(item.score) ||
      item.score < 0 ||
      item.score > 100
    ) {
      throw new TypeError('evaluation.skillEvidence contains an invalid item');
    }
  }
  if (!['complete', 'retry'].includes(evaluation.nextAction)) {
    throw new TypeError('evaluation.nextAction is invalid');
  }
  if ((evaluation.verdict === 'passed') !== (evaluation.nextAction === 'complete')) {
    throw new TypeError('evaluation.verdict and nextAction are inconsistent');
  }
}

function addSkillEvidence(state, run, attempt, evaluation, result, now) {
  for (const item of evaluation.skillEvidence) {
    const progress = state.skillProgress[item.skillId] ?? {
      skillId: item.skillId,
      status: 'practicing',
      score: 0,
      bestScore: 0,
      lastPracticedAt: null,
      evidence: [],
    };
    progress.score = item.score;
    progress.bestScore = Math.max(progress.bestScore, item.score);
    progress.lastPracticedAt = now;

    if (result === 'mastered') progress.status = 'mastered';
    if (result === 'completed_supported' && progress.status !== 'mastered') {
      progress.status = 'completed_supported';
    }
    if (result === 'needs_revision' && progress.status !== 'mastered') {
      progress.status = 'practicing';
    }
    if (result === 'review_failed' && progress.status === 'mastered') {
      progress.status = 'needs_review';
    }

    progress.evidence.push({
      runId: run.id,
      attemptId: attempt.id,
      kind: run.kind,
      score: item.score,
      result,
      at: now,
    });
    state.skillProgress[item.skillId] = progress;
  }
}

function scheduleReviews(state, run, now) {
  for (const intervalDays of run.lessonSnapshot.reviewIntervals) {
    const id = `review:${run.id}:${intervalDays}`;
    if (state.reviewQueue.some((review) => review.id === id)) continue;
    state.reviewQueue.push({
      id,
      lessonId: run.lessonId,
      levelId: run.levelId,
      sourceRunId: run.id,
      intervalDays,
      dueAt: addDays(now, intervalDays),
      skillIds: clone(run.lessonSnapshot.primarySkills),
      status: 'pending',
      failureCount: 0,
      runId: null,
      completedAt: null,
    });
  }
}

function compareRunQuality(left, right) {
  const rank = (run) => [
    run.status === 'mastered' ? 2 : run.status === 'completed_supported' ? 1 : 0,
    Number.isFinite(run.score) ? run.score : 0,
    run.status === 'mastered' || !run.solutionViewed ? 1 : 0,
    -(run.hintLevelRevealed || 0),
    -(run.failureCount || 0),
    -(run.attempts?.length || 0),
  ];
  const leftRank = rank(left);
  const rightRank = rank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  }
  return 0;
}

function keepBestLessonRun(state, lessonId) {
  const candidates = state.lessonRuns.filter(run =>
    run.kind !== 'review' && run.lessonId === lessonId && COMPLETED_STATUSES.has(run.status)
  );
  if (candidates.length < 2) return;

  const best = candidates.slice(1).reduce((current, candidate) =>
    compareRunQuality(candidate, current) > 0 ? candidate : current
  , candidates[0]);
  const removedRunIds = new Set(candidates.filter(run => run.id !== best.id).map(run => run.id));
  const removedReviewIds = new Set(state.reviewQueue
    .filter(review => removedRunIds.has(review.sourceRunId))
    .map(review => review.id));
  const removedEvidenceRunIds = new Set(removedRunIds);

  state.lessonRuns = state.lessonRuns.filter(run => {
    const remove = removedRunIds.has(run.id) || removedReviewIds.has(run.reviewId);
    if (remove) removedEvidenceRunIds.add(run.id);
    return !remove;
  });
  for (const run of state.lessonRuns) {
    if (removedEvidenceRunIds.has(run.previousRunId)) run.previousRunId = null;
  }
  state.reviewQueue = state.reviewQueue.filter(review => !removedReviewIds.has(review.id));
  if (removedEvidenceRunIds.has(state.currentRunId)) state.currentRunId = null;

  for (const [skillId, progress] of Object.entries(state.skillProgress)) {
    progress.evidence = progress.evidence.filter(item => !removedEvidenceRunIds.has(item.runId));
    if (!progress.evidence.length) {
      delete state.skillProgress[skillId];
      continue;
    }
    progress.score = 0;
    progress.bestScore = 0;
    progress.status = 'practicing';
    for (const evidence of progress.evidence) {
      progress.score = evidence.score;
      progress.bestScore = Math.max(progress.bestScore, evidence.score);
      progress.lastPracticedAt = evidence.at;
      if (evidence.result === 'mastered') progress.status = 'mastered';
      if (evidence.result === 'completed_supported' && progress.status !== 'mastered') {
        progress.status = 'completed_supported';
      }
      if (evidence.result === 'needs_revision' && progress.status !== 'mastered') {
        progress.status = 'practicing';
      }
      if (evidence.result === 'review_failed' && progress.status === 'mastered') {
        progress.status = 'needs_review';
      }
    }
  }
}

function addRunMessage(run, { id, timestamp, type, role, content }) {
  if (run.messages.some((message) => message.id === id)) {
    throw new Error(`Duplicate message id: ${id}`);
  }
  run.messages.push({ id, timestamp, type, role, content });
}

export function createInitialLearningState({
  trackId,
  trackVersion,
  selectedLevelId,
  now = new Date(),
}) {
  requireText(trackId, 'trackId');
  requireText(selectedLevelId, 'selectedLevelId');
  if (!['string', 'number'].includes(typeof trackVersion)) {
    throw new TypeError('trackVersion must be a string or number');
  }
  const timestamp = asIso(now);
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    settings: {
      trackId,
      trackVersion,
      selectedLevelId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    lessonRuns: [],
    skillProgress: {},
    reviewQueue: [],
    currentRunId: null,
  };
}

export function validateLearningState(state) {
  const errors = [];
  try {
    if (!isObject(state)) return { valid: false, errors: ['state must be an object'] };
    if (state.schemaVersion !== LEARNING_SCHEMA_VERSION) errors.push('invalid schemaVersion');
    if (!isObject(state.settings)) errors.push('settings must be an object');
    if (!Array.isArray(state.lessonRuns)) errors.push('lessonRuns must be an array');
    if (!isObject(state.skillProgress)) errors.push('skillProgress must be an object');
    if (!Array.isArray(state.reviewQueue)) errors.push('reviewQueue must be an array');
    if (state.currentRunId !== null && typeof state.currentRunId !== 'string') {
      errors.push('currentRunId must be null or a string');
    }
    if (isObject(state.settings)) {
      for (const field of ['trackId', 'selectedLevelId']) {
        if (typeof state.settings[field] !== 'string' || !state.settings[field]) {
          errors.push(`settings.${field} is required`);
        }
      }
      if (!['string', 'number'].includes(typeof state.settings.trackVersion)) {
        errors.push('settings.trackVersion is required');
      }
    }
    if (
      typeof state.currentRunId === 'string' &&
      Array.isArray(state.lessonRuns) &&
      !state.lessonRuns.some(
        (run) => run?.id === state.currentRunId && run.status === 'in_progress',
      )
    ) {
      errors.push('currentRunId must reference an in-progress run');
    }
    JSON.stringify(state);
  } catch (error) {
    errors.push(`state could not be inspected: ${error.message}`);
  }
  return { valid: errors.length === 0, errors };
}

export function selectNextLesson(curriculum, state, options = {}) {
  assertState(state);
  const active = getActiveRun(state);
  if (active) return { kind: 'resume', runId: active.id, run: clone(active) };

  const now = Date.parse(asIso(options.now ?? new Date()));
  if (!options.skipReviews) {
    const review = state.reviewQueue
      .filter((item) => item.status === 'pending' && Date.parse(item.dueAt) <= now)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
    if (review) {
      const lesson = findLesson(curriculum, review.lessonId);
      if (!lesson) throw new RangeError(`Unknown review lesson: ${review.lessonId}`);
      return {
        kind: 'review',
        reviewId: review.id,
        lessonId: lesson.id,
        levelId: lesson.levelId,
        lesson: clone(lesson),
        review: clone(review),
      };
    }
  }

  const sequence = curriculumSequence(curriculum, state.settings.selectedLevelId);
  const openRun = sequence.map(lesson =>
    state.lessonRuns.find(run =>
      run.kind !== 'review' && run.lessonId === lesson.id && run.status === 'in_progress'
    )
  ).find(Boolean);
  if (openRun) return { kind: 'resume', runId: openRun.id, run: clone(openRun) };

  const completed = new Set(
    state.lessonRuns
      .filter((run) => run.kind !== 'review' && COMPLETED_STATUSES.has(run.status))
      .map((run) => run.lessonId),
  );
  const lesson = sequence.find(
    (candidate) => !completed.has(candidate.id),
  );
  return lesson ? lessonDescriptor(lesson) : null;
}

export function startLessonRun(state, input, options = {}) {
  assertState(state);
  if (getActiveRun(state)) throw new Error('Complete the active run before starting another');
  if (!isObject(input)) throw new TypeError('lesson must be an object');

  const descriptor = isObject(input.lesson) ? input : null;
  const lesson = descriptor?.lesson ?? input;
  requireText(lesson.id, 'lesson.id');
  requireText(lesson.levelId, 'lesson.levelId');

  let kind = options.kind ?? descriptor?.kind ?? (isCheckpoint(lesson) ? 'checkpoint' : 'lesson');
  if (kind !== 'review' && isCheckpoint(lesson)) kind = 'checkpoint';
  if (!['lesson', 'checkpoint', 'review'].includes(kind)) throw new TypeError('invalid run kind');

  const reviewId = options.reviewId ?? descriptor?.reviewId ?? null;
  if (kind === 'review') {
    const review = state.reviewQueue.find((item) => item.id === reviewId);
    if (!review || review.status !== 'pending') throw new Error('review is not pending');
  }

  const timestamp = asIso(options.now ?? new Date());
  const dateKey = options.dateKey ?? timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError('invalid dateKey');
  const id = makeId(options.id, options.idFactory, 'run id');
  if (state.lessonRuns.some((run) => run.id === id)) throw new Error(`Duplicate run id: ${id}`);
  const maxHintLevel = options.maxHintLevel ?? 3;
  if (!Number.isInteger(maxHintLevel) || maxHintLevel < 0) {
    throw new TypeError('maxHintLevel must be a non-negative integer');
  }

  const dailyOrder =
    Math.max(
      0,
      ...state.lessonRuns
        .filter((run) => run.dateKey === dateKey)
        .map((run) => run.dailyOrder),
    ) + 1;
  const lessonSnapshot = snapshotLesson(lesson);
  const run = {
    id,
    lessonId: lesson.id,
    levelId: lesson.levelId,
    kind,
    reviewId: kind === 'review' ? reviewId : null,
    status: 'in_progress',
    phase: 'challenge',
    dateKey,
    dailyOrder,
    previousRunId: state.lessonRuns.at(-1)?.id ?? null,
    conversationId: options.conversationId ?? null,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    trackId: state.settings.trackId,
    trackVersion: clone(state.settings.trackVersion),
    lessonSnapshot,
    skillIds: clone(lessonSnapshot.primarySkills),
    attempts: [],
    messages: [],
    failureCount: 0,
    maxHintLevel,
    hintLevelUnlocked: maxHintLevel,
    hintLevelRevealed: 0,
    solutionViewed: false,
    solutionViewedAt: null,
  };

  const next = clone(state);
  next.lessonRuns.push(run);
  next.currentRunId = id;
  if (kind === 'review') {
    const review = next.reviewQueue.find((item) => item.id === reviewId);
    review.status = 'in_progress';
    review.runId = id;
  }
  touch(next, timestamp);
  return next;
}

export function appendLessonMessage(state, runId, message, options = {}) {
  assertState(state);
  if (!isObject(message)) throw new TypeError('message must be an object');
  requireText(message.type, 'message.type');
  requireText(message.role, 'message.role');
  if (typeof message.content !== 'string') throw new TypeError('message.content must be a string');

  const timestamp = asIso(message.timestamp ?? options.now ?? new Date());
  const id = makeId(message.id ?? options.id, options.idFactory, 'message id');
  const next = clone(state);
  const run = getRun(next, runId);
  addRunMessage(run, {
    id,
    timestamp,
    type: message.type,
    role: message.role,
    content: message.content,
  });
  run.updatedAt = timestamp;
  touch(next, timestamp);
  return next;
}

export function submitAttempt(state, runId, submission, options = {}) {
  assertState(state);
  const timestamp = asIso(options.now ?? new Date());
  const attemptId = makeId(options.id, options.idFactory, 'attempt id');
  const messageId = makeId(options.messageId, options.idFactory, 'message id');
  const next = clone(state);
  const run = getRun(next, runId);
  if (run.status !== 'in_progress') throw new Error('run is already complete');
  if (run.attempts.some((attempt) => attempt.status === 'evaluation_pending')) {
    throw new Error('an attempt is already evaluation_pending');
  }
  if (run.attempts.some((attempt) => attempt.id === attemptId)) {
    throw new Error(`Duplicate attempt id: ${attemptId}`);
  }

  run.attempts.push({
    id: attemptId,
    submittedAt: timestamp,
    status: 'evaluation_pending',
    submission: clone(submission),
    evaluation: null,
    evaluatedAt: null,
  });
  addRunMessage(run, {
    id: messageId,
    timestamp,
    type: 'attempt',
    role: 'user',
    content: submissionContent(submission),
  });
  run.phase = 'evaluation_pending';
  run.updatedAt = timestamp;
  next.currentRunId = run.id;
  touch(next, timestamp);
  return next;
}

export function recordEvaluation(state, runId, attemptId, evaluation, options = {}) {
  assertState(state);
  validateEvaluation(evaluation);
  const timestamp = asIso(options.now ?? new Date());
  const messageId = makeId(options.messageId ?? options.id, options.idFactory, 'message id');
  const next = clone(state);
  const run = getRun(next, runId);
  const attempt = run.attempts.find((item) => item.id === attemptId);
  if (run.status !== 'in_progress') throw new Error('run is already complete');
  if (!attempt) throw new RangeError(`Unknown attempt: ${attemptId}`);
  if (attempt.status !== 'evaluation_pending') throw new Error('attempt is already evaluated');

  if (evaluation.verdict !== 'evaluation_error') {
    const allowedSkills = new Set(run.skillIds);
    const evidenceSkills = new Set(evaluation.skillEvidence.map(item => item.skillId));
    if (!run.skillIds.length || evaluation.skillEvidence.some(item => !allowedSkills.has(item.skillId))
        || run.skillIds.some(skillId => !evidenceSkills.has(skillId))) {
      throw new TypeError('evaluation.skillEvidence must match the lesson skills');
    }
    const threshold = run.kind === 'checkpoint' || isCheckpoint(run.lessonSnapshot) ? 85 : 80;
    const shouldPass = evaluation.score >= threshold && evaluation.criticalChecksPassed;
    if ((evaluation.verdict === 'passed') !== shouldPass) {
      throw new TypeError('evaluation verdict does not match the lesson threshold');
    }
  }

  attempt.evaluation = clone(evaluation);
  attempt.evaluatedAt = timestamp;
  addRunMessage(run, {
    id: messageId,
    timestamp,
    type: evaluation.verdict === 'evaluation_error' ? 'evaluation_error' : 'evaluation',
    role: 'assistant',
    content: evaluation.feedback,
  });
  run.updatedAt = timestamp;

  if (evaluation.verdict === 'evaluation_error') {
    attempt.status = 'evaluation_error';
    run.phase = run.solutionViewed ? 'solution' : 'challenge';
    if (run.reviewId) {
      const review = next.reviewQueue.find((item) => item.id === run.reviewId);
      if (review) review.lastErrorAt = timestamp;
    }
    touch(next, timestamp);
    return next;
  }

  const threshold = run.kind === 'checkpoint' || isCheckpoint(run.lessonSnapshot) ? 85 : 80;
  const passed =
    evaluation.verdict === 'passed' &&
    evaluation.score >= threshold &&
    evaluation.criticalChecksPassed;
  attempt.status = passed ? 'passed' : 'needs_revision';

  if (passed) {
    const result = run.solutionViewed ? 'completed_supported' : 'mastered';
    run.status = run.kind === 'review' && result === 'mastered' ? 'review_completed' : result;
    run.phase = 'complete';
    run.completedAt = timestamp;
    run.score = evaluation.score;
    next.currentRunId = null;
    addSkillEvidence(next, run, attempt, evaluation, result, timestamp);

    if (run.kind === 'review') {
      const review = next.reviewQueue.find((item) => item.id === run.reviewId);
      if (!review) throw new RangeError(`Unknown review: ${run.reviewId}`);
      review.status = 'completed';
      review.completedAt = timestamp;
      review.result = result;
      review.lastScore = evaluation.score;
    } else if (result === 'mastered') {
      scheduleReviews(next, run, timestamp);
    }
    if (run.kind !== 'review') keepBestLessonRun(next, run.lessonId);
  } else {
    attempt.status = 'needs_revision';
    run.failureCount += 1;
    run.phase = 'retry';
    const result = run.kind === 'review' ? 'review_failed' : 'needs_revision';
    addSkillEvidence(next, run, attempt, evaluation, result, timestamp);
    if (run.kind === 'review') {
      const review = next.reviewQueue.find((item) => item.id === run.reviewId);
      if (!review) throw new RangeError(`Unknown review: ${run.reviewId}`);
      review.failureCount += 1;
      review.lastScore = evaluation.score;
      review.lastEvaluatedAt = timestamp;
    }
  }

  touch(next, timestamp);
  return next;
}

export function revealHint(state, runId, level, options = {}) {
  assertState(state);
  if (!Number.isInteger(level) || level < 1) throw new TypeError('level must be a positive integer');
  const timestamp = asIso(options.now ?? new Date());
  const next = clone(state);
  const run = getRun(next, runId);
  if (run.status !== 'in_progress') throw new Error('run is already complete');
  if (level > run.hintLevelUnlocked) throw new RangeError(`Hint level ${level} is not unlocked`);
  if (level > run.hintLevelRevealed + 1) throw new RangeError('Hints must be revealed in order');
  run.hintLevelRevealed = Math.max(run.hintLevelRevealed, level);
  run.hintRevealedAt = timestamp;
  run.updatedAt = timestamp;
  touch(next, timestamp);
  return next;
}

export function revealSolution(state, runId, options = {}) {
  assertState(state);
  const timestamp = asIso(options.now ?? new Date());
  const next = clone(state);
  const run = getRun(next, runId);
  if (run.status !== 'in_progress' && !COMPLETED_STATUSES.has(run.status)) {
    throw new Error('run cannot reveal a solution');
  }
  const bestScore = Math.max(0, ...run.attempts.map(attempt =>
    attempt.status !== 'evaluation_error' && Number.isFinite(attempt.evaluation?.score)
      ? attempt.evaluation.score
      : 0
  ));
  if (bestScore < SOLUTION_UNLOCK_SCORE) {
    throw new RangeError(`solution requires a score of at least ${SOLUTION_UNLOCK_SCORE}`);
  }
  run.solutionViewed = true;
  run.solutionViewedAt ??= timestamp;
  if (run.status === 'in_progress') run.phase = 'solution';
  run.updatedAt = timestamp;
  touch(next, timestamp);
  return next;
}

export function getLearningSummary(curriculum, state, now = new Date()) {
  assertState(state);
  const timestamp = asIso(now);
  const today = timestamp.slice(0, 10);
  const lessons = curriculumSequence(curriculum, state.settings.selectedLevelId);
  const completed = new Map();
  for (const run of state.lessonRuns) {
    if (run.kind !== 'review' && COMPLETED_STATUSES.has(run.status)) {
      completed.set(run.lessonId, run.status);
    }
  }
  const current = getActiveRun(state);
  const nextLesson = lessons.find((lesson) => !completed.has(lesson.id));
  const completedLessons = lessons.filter((lesson) => completed.has(lesson.id)).length;

  return {
    counts: {
      totalLessons: lessons.length,
      completedLessons,
      masteredLessons: [...completed.values()].filter((status) => status === 'mastered').length,
      supportedLessons: [...completed.values()].filter(
        (status) => status === 'completed_supported',
      ).length,
    },
    progress: {
      completed: completedLessons,
      total: lessons.length,
      percent: lessons.length ? Math.round((completedLessons / lessons.length) * 100) : 0,
    },
    level: {
      selectedId: state.settings.selectedLevelId,
      currentId: current?.levelId ?? nextLesson?.levelId ?? lessons.at(-1)?.levelId ?? null,
    },
    today: {
      dateKey: today,
      runsStarted: state.lessonRuns.filter((run) => run.dateKey === today).length,
      lessonsCompleted: state.lessonRuns.filter(
        (run) =>
          run.kind !== 'review' &&
          COMPLETED_STATUSES.has(run.status) &&
          run.completedAt?.startsWith(today),
      ).length,
      attemptsSubmitted: state.lessonRuns.reduce(
        (total, run) =>
          total + run.attempts.filter((attempt) => attempt.submittedAt.startsWith(today)).length,
        0,
      ),
    },
    dueReviews: state.reviewQueue.filter(
      (review) => review.status === 'pending' && Date.parse(review.dueAt) <= Date.parse(timestamp),
    ).length,
  };
}

export function getChronology(state) {
  assertState(state);
  const dates = new Map();
  for (const run of state.lessonRuns) {
    if (!dates.has(run.dateKey)) dates.set(run.dateKey, []);
    dates.get(run.dateKey).push(clone(run));
  }
  return [...dates.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, runs]) => ({
      dateKey,
      runs: runs.sort((a, b) => a.dailyOrder - b.dailyOrder),
    }));
}
