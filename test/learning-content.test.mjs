import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LESSON_MODALITIES,
  lessonModality,
  markdownCodeBlock,
  mergeLearningContent,
  projectFilesMarkdown,
} from '../scripts/learning-content.mjs';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

const [baseCurriculum, baseSupport, scenarios, advancedConsole, projectCourses] = await Promise.all([
  readJson('../learning/curriculum.json'),
  readJson('../learning/support.json'),
  readJson('../learning/scenarios.json'),
  readJson('../learning/advanced-console.json'),
  readJson('../learning/project-courses.json'),
]);

const merged = mergeLearningContent(baseCurriculum, baseSupport, [
  advancedConsole,
  projectCourses,
]);

test('merges twelve courses while preserving the thirteen legacy lessons', () => {
  assert.equal(merged.curriculum.levels.length, 12);
  assert.equal(merged.curriculum.lessons.length, 53);
  assert.equal(merged.support.lessons.length, 53);
  assert.equal(merged.curriculum.startPolicy.availableStartLevelIds.length, 12);
  assert.deepEqual(
    merged.curriculum.lessons.slice(0, 13).map(lesson => lesson.id),
    baseCurriculum.lessons.map(lesson => lesson.id),
  );
  assert.equal(merged.curriculum.routeId, 'js-arrays-console-v1');
  assert.equal(merged.curriculum.schemaVersion, 1);
});

test('all console lessons resolve real datasets and retain executable support', () => {
  const scenarioById = new Map(scenarios.scenarios.map(scenario => [scenario.id, scenario]));
  const supportById = new Map(merged.support.lessons.map(item => [item.lessonId, item]));
  const consoleLessons = merged.curriculum.lessons.filter(
    lesson => lessonModality(lesson) === LESSON_MODALITIES.CONSOLE,
  );

  assert.equal(consoleLessons.length, 33);
  for (const lesson of consoleLessons) {
    const scenario = scenarioById.get(lesson.scenarioId);
    assert.ok(scenario, `${lesson.id} scenario`);
    assert.ok(scenario.datasets.some(dataset => dataset.id === lesson.datasetId), `${lesson.id} dataset`);
    assert.equal(typeof lesson.starterCode, 'string');
    assert.equal(typeof supportById.get(lesson.id).solution.executableCode, 'string');
  }
});

test('project lessons declare complete starters, ordered submissions, and matching solutions', () => {
  const supportById = new Map(merged.support.lessons.map(item => [item.lessonId, item]));
  const projectLessons = merged.curriculum.lessons.filter(
    lesson => lessonModality(lesson) === LESSON_MODALITIES.PROJECT_FILES,
  );

  assert.equal(projectLessons.length, 20);
  for (const lesson of projectLessons) {
    const starterPaths = new Set(lesson.starterFiles.map(file => file.path));
    const solutionPaths = supportById.get(lesson.id).solution.files.map(file => file.path);
    assert.deepEqual(solutionPaths, lesson.submissionFiles, `${lesson.id} solution order`);
    assert.ok(lesson.submissionFiles.every(path => starterPaths.has(path)), `${lesson.id} starter paths`);
    assert.equal(lesson.workspace.url, 'http://localhost:5173');
    assert.match(lesson.workspace.startCommand, /--port 5173 --strictPort$/);
    assert.equal(lesson.rubric.reduce((total, item) => total + item.points, 0), 100);
  }
});

test('content merging rejects duplicate ids and unsafe project paths', () => {
  const duplicate = structuredClone(advancedConsole);
  duplicate.levels[0].id = baseCurriculum.levels[0].id;
  assert.throws(
    () => mergeLearningContent(baseCurriculum, baseSupport, [duplicate]),
    /duplicate id/,
  );

  const unsafe = structuredClone(projectCourses);
  unsafe.lessons[0].starterFiles[0].path = '../package.json';
  assert.throws(
    () => mergeLearningContent(baseCurriculum, baseSupport, [unsafe]),
    /Invalid project path/,
  );
});

test('multi-file Markdown cannot be closed by backticks inside a source file', () => {
  const block = markdownCodeBlock('javascript', 'const text = "```";');
  assert.match(block, /^````javascript/);
  assert.match(block, /\n````$/);

  const rendered = projectFilesMarkdown([
    { path: 'src/App.jsx', language: 'jsx', content: 'export default function App() {}' },
  ]);
  assert.match(rendered, /### `src\/App\.jsx`/);
  assert.match(rendered, /```jsx/);
});
