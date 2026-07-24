export const LESSON_MODALITIES = Object.freeze({
  CONSOLE: 'console',
  PROJECT_FILES: 'project_files',
});

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function assertUnique(items, getId, name) {
  const ids = new Set();
  for (const item of items) {
    const id = getId(item);
    if (typeof id !== 'string' || !id.trim()) throw new TypeError(`${name} contains an invalid id`);
    if (ids.has(id)) throw new Error(`${name} contains duplicate id: ${id}`);
    ids.add(id);
  }
  return ids;
}

function assertSafeProjectPath(path, lessonId) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\\')
      || path.startsWith('/') || path.split('/').includes('..') || /[\u0000-\u001f]/.test(path)) {
    throw new Error(`Invalid project path in ${lessonId}: ${path}`);
  }
}

function validateProjectLesson(lesson, lessonSupport) {
  if (lesson.runtime?.environment !== 'browser' || typeof lesson.workspace?.projectId !== 'string') {
    throw new Error(`${lesson.id} requires a browser runtime and workspace`);
  }
  if (!Array.isArray(lesson.expectedBrowserResult) || !lesson.expectedBrowserResult.length) {
    throw new Error(`${lesson.id} requires an expected browser result`);
  }
  const starterFiles = requireArray(lesson.starterFiles, `${lesson.id}.starterFiles`);
  const submissionFiles = requireArray(lesson.submissionFiles, `${lesson.id}.submissionFiles`);
  const solutionFiles = requireArray(lessonSupport?.solution?.files, `${lesson.id}.solution.files`);
  if (!starterFiles.length || !submissionFiles.length || !solutionFiles.length) {
    throw new Error(`${lesson.id} requires starter, submission, and solution files`);
  }

  const starterPaths = assertUnique(starterFiles, file => file?.path, `${lesson.id}.starterFiles`);
  const solutionPaths = assertUnique(solutionFiles, file => file?.path, `${lesson.id}.solution.files`);
  const requestedPaths = assertUnique(submissionFiles, path => path, `${lesson.id}.submissionFiles`);

  for (const file of [...starterFiles, ...solutionFiles]) {
    assertSafeProjectPath(file.path, lesson.id);
    if (typeof file.content !== 'string') throw new TypeError(`${lesson.id}:${file.path} content must be text`);
  }
  for (const path of requestedPaths) {
    assertSafeProjectPath(path, lesson.id);
    if (!starterPaths.has(path)) throw new Error(`${lesson.id} starter is missing ${path}`);
    if (!solutionPaths.has(path)) throw new Error(`${lesson.id} solution is missing ${path}`);
  }
  if (solutionPaths.size !== requestedPaths.size) {
    throw new Error(`${lesson.id} solution files must match submissionFiles exactly`);
  }
}

export function lessonModality(lesson) {
  const modality = lesson?.modality ?? LESSON_MODALITIES.CONSOLE;
  if (!Object.values(LESSON_MODALITIES).includes(modality)) {
    throw new Error(`Unsupported lesson modality: ${modality}`);
  }
  return modality;
}

export function mergeLearningContent(baseCurriculum, baseSupport, extensions = []) {
  const curriculum = clone(baseCurriculum);
  const support = clone(baseSupport);
  requireArray(curriculum.levels, 'curriculum.levels');
  requireArray(curriculum.lessons, 'curriculum.lessons');
  requireArray(support.lessons, 'support.lessons');

  for (const extension of extensions) {
    if (extension?.routeId !== curriculum.routeId) {
      throw new Error('Learning extension routeId does not match the curriculum');
    }
    if (extension.schemaVersion !== curriculum.schemaVersion) {
      throw new Error('Learning extension schemaVersion does not match the curriculum');
    }
    curriculum.levels.push(...clone(requireArray(extension.levels, 'extension.levels')));
    curriculum.lessons.push(...clone(requireArray(extension.lessons, 'extension.lessons')));
    support.lessons.push(...clone(requireArray(extension.supportLessons, 'extension.supportLessons')));
  }

  const levelIds = assertUnique(curriculum.levels, level => level?.id, 'curriculum.levels');
  const lessonIds = assertUnique(curriculum.lessons, lesson => lesson?.id, 'curriculum.lessons');
  const supportIds = assertUnique(support.lessons, item => item?.lessonId, 'support.lessons');
  const listedLessonIds = new Set();

  for (const level of curriculum.levels) {
    for (const lessonId of requireArray(level.lessonIds, `${level.id}.lessonIds`)) {
      if (!lessonIds.has(lessonId)) throw new Error(`${level.id} references unknown lesson ${lessonId}`);
      if (listedLessonIds.has(lessonId)) throw new Error(`Lesson is listed more than once: ${lessonId}`);
      listedLessonIds.add(lessonId);
      const lesson = curriculum.lessons.find(candidate => candidate.id === lessonId);
      if (lesson.levelId !== level.id) throw new Error(`${lessonId} has an inconsistent levelId`);
    }
  }

  if (listedLessonIds.size !== lessonIds.size) throw new Error('Every lesson must belong to exactly one level');
  if (supportIds.size !== lessonIds.size || [...lessonIds].some(id => !supportIds.has(id))) {
    throw new Error('Every lesson must have exactly one support entry');
  }

  for (const lesson of curriculum.lessons) {
    if (!Array.isArray(lesson.primarySkills) || !lesson.primarySkills.length) {
      throw new Error(`${lesson.id} requires at least one primary skill`);
    }
    if (lessonModality(lesson) === LESSON_MODALITIES.PROJECT_FILES) {
      validateProjectLesson(lesson, support.lessons.find(item => item.lessonId === lesson.id));
    }
  }

  const manualLevelIds = curriculum.levels
    .filter(level => level.manualStartAllowed !== false)
    .map(level => level.id);
  curriculum.startPolicy = {
    ...(curriculum.startPolicy || {}),
    availableStartLevelIds: manualLevelIds,
  };

  for (const id of curriculum.startPolicy.availableStartLevelIds) {
    if (!levelIds.has(id)) throw new Error(`Unknown start level: ${id}`);
  }

  return { curriculum, support };
}

export function markdownCodeBlock(language, content) {
  const text = String(content ?? '');
  const longestFence = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  const safeLanguage = /^[a-z0-9_+-]+$/i.test(language || '') ? language : 'text';
  return `${fence}${safeLanguage}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

export function projectFilesMarkdown(files, headingLevel = 3) {
  const heading = '#'.repeat(Math.min(6, Math.max(1, headingLevel)));
  return requireArray(files, 'files').map(file => {
    const path = String(file.path).replace(/[`\r\n]/g, '');
    return `${heading} \`${path}\`\n\n${markdownCodeBlock(file.language, file.content)}`;
  }).join('\n\n');
}
