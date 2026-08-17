import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCHEDULER_SETTINGS,
  SCHEDULER_VERSION,
  isValidStepList,
  migrateWorkspaceScheduler,
  nextQuestion,
  normalizeSchedulerSettings,
  scheduleReview,
} from './js/scheduler.js';
import {BACKUP_FORMAT, backupFromWorkspace, validatePayload} from './js/formats.js';

const start = new Date('2026-08-17T10:00:00Z');
const minutesUntil = dueAt => (new Date(dueAt) - start) / 60000;

test('FSRS uses short ordered learning steps for all four ratings', async () => {
  const results = {};
  for (const rating of ['forgot', 'partial', 'effort', 'easy']) {
    results[rating] = await scheduleReview('q', null, rating, true, start);
  }

  assert.equal(minutesUntil(results.forgot.card.dueAt), 1);
  assert.equal(minutesUntil(results.partial.card.dueAt), 6);
  assert.equal(minutesUntil(results.effort.card.dueAt), 10);
  assert.equal(minutesUntil(results.easy.card.dueAt), 8 * 24 * 60);
  assert.deepEqual(
    Object.values(results).map(result => result.card.scheduler),
    ['fsrs-6', 'fsrs-6', 'fsrs-6', 'fsrs-6'],
  );
});

test('FSRS grows stability after recall and relearns a forgotten review after one minute', async () => {
  const first = await scheduleReview('q', null, 'effort', true, start);
  const learnedAt = new Date(first.card.dueAt);
  const learned = await scheduleReview('q', first.card, 'effort', true, learnedAt);
  assert.equal(learned.card.state, 'review');
  assert.equal(learned.card.scheduledDays, 2);

  const recalledAt = new Date(learned.card.dueAt);
  const recalled = await scheduleReview('q', learned.card, 'effort', true, recalledAt);
  assert.ok(recalled.card.stability > learned.card.stability);
  assert.ok(recalled.card.scheduledDays > learned.card.scheduledDays);

  const forgottenAt = new Date(recalled.card.dueAt);
  const forgotten = await scheduleReview('q', recalled.card, 'forgot', false, forgottenAt);
  assert.equal(forgotten.card.state, 'relearning');
  assert.equal((new Date(forgotten.card.dueAt) - forgottenAt) / 60000, 1);
  assert.equal(forgotten.card.lapses, 1);
});

test('higher requested retention produces a shorter dynamic interval', async () => {
  const card = {
    scheduler: 'fsrs-6', state: 'review', dueAt: start.toISOString(),
    lastReviewedAt: '2026-08-07T10:00:00Z', stability: 10, difficulty: 5,
    elapsedDays: 10, scheduledDays: 10, learningSteps: 0,
    repetitions: 8, lapses: 1, suspended: false,
  };
  const lower = await scheduleReview('q', card, 'effort', true, start, {requestRetentionPercent: 80});
  const higher = await scheduleReview('q', card, 'effort', true, start, {requestRetentionPercent: 95});
  assert.ok(lower.card.scheduledDays > higher.card.scheduledDays);
});

test('fuzz remains stable between preview and click time for the same card', async () => {
  const card = {
    scheduler: 'fsrs-6', state: 'review', dueAt: start.toISOString(),
    lastReviewedAt: '2026-07-18T10:00:00Z', stability: 30, difficulty: 5,
    elapsedDays: 30, scheduledDays: 30, learningSteps: 0,
    repetitions: 8, lapses: 0, suspended: false,
  };
  const preview = await scheduleReview('q', card, 'effort', true, start, {enableFuzz: true});
  const clicked = await scheduleReview('q', card, 'effort', true, new Date(start.getTime() + 5000), {enableFuzz: true});
  assert.equal(preview.card.scheduledDays, clicked.card.scheduledDays);
});

test('scheduler settings validate step lists and normalize invalid input', () => {
  assert.equal(isValidStepList('1m, 10m, 1d'), true);
  assert.equal(isValidStepList('1 Minute'), false);
  assert.equal(isValidStepList('10m, 1m'), false);
  assert.equal(isValidStepList('0m'), false);
  assert.deepEqual(normalizeSchedulerSettings({learningSteps: 'kaputt'}), DEFAULT_SCHEDULER_SETTINGS);
});

test('legacy SM-2 cards migrate without changing their existing due date or suspension', () => {
  const legacyDue = '2026-09-01T08:00:00Z';
  const workspace = {
    id: 'bank', bank: {id: 'bank'}, questions: [{id: 'q'}],
    cards: {q: {
      state: 'review', stepIndex: 0, ease: 2.15, intervalDays: 14,
      dueAt: legacyDue, lastReviewedAt: '2026-08-10T08:00:00Z',
      repetitions: 4, lapses: 1, suspended: true,
      createdAt: '2026-08-01T08:00:00Z', updatedAt: '2026-08-10T08:00:00Z',
    }},
    reviews: [
      {questionId: 'q', reviewedAt: '2026-08-01T08:00:00Z', rating: 'effort'},
      {questionId: 'q', reviewedAt: '2026-08-01T08:10:00Z', rating: 'effort'},
      {questionId: 'q', reviewedAt: '2026-08-03T08:10:00Z', rating: 'effort'},
      {questionId: 'q', reviewedAt: '2026-08-10T08:00:00Z', rating: 'partial'},
    ],
    settings: {scheduler: {firstLearningMinutes: 30}},
  };

  const migration = migrateWorkspaceScheduler(workspace, start);
  const card = migration.workspace.cards.q;
  assert.equal(migration.migrated, true);
  assert.equal(migration.workspace.schedulerVersion, SCHEDULER_VERSION);
  assert.equal(card.scheduler, 'fsrs-6');
  assert.equal(card.dueAt, legacyDue);
  assert.equal(card.suspended, true);
  assert.equal(card.state, 'review');
  assert.ok(card.stability > 0);
  assert.ok(card.difficulty > 0);
  assert.deepEqual(migration.workspace.settings.legacySchedulerV1, {firstLearningMinutes: 30});
});

test('learning cards can be shown early only after regular due and new cards are exhausted', () => {
  const learningCard = {
    state: 'learning', dueAt: '2026-08-17T10:10:00Z', suspended: false,
  };
  const earlyWorkspace = {
    questions: [{id: 'learning'}], cards: {learning: learningCard},
    settings: {scheduler: {learnAheadMinutes: 15}},
  };
  assert.equal(nextQuestion(earlyWorkspace, null, start, 'session').id, 'learning');
  assert.equal(nextQuestion({...earlyWorkspace, settings: {scheduler: {learnAheadMinutes: 0}}}, null, start, 'session'), null);

  const withNew = {
    ...earlyWorkspace,
    questions: [{id: 'learning'}, {id: 'new'}],
  };
  assert.equal(nextQuestion(withNew, null, start, 'session').id, 'new');
});

test('backup format exports scheduler v2 and continues to accept scheduler v1 imports', () => {
  const workspace = {
    bank: {id: 'bank', name: 'Test'}, assets: {},
    questions: [{id: 'q', type: 'single_choice', answer: {options: []}}],
    cards: {}, reviews: [], settings: {scheduler: DEFAULT_SCHEDULER_SETTINGS},
  };
  const backup = backupFromWorkspace(workspace);
  assert.equal(backup.progress.schedulerVersion, SCHEDULER_VERSION);
  assert.equal(validatePayload(backup).format, BACKUP_FORMAT);
  assert.equal(validatePayload({...backup, progress: {...backup.progress, schedulerVersion: 1}}).progress.schedulerVersion, 1);
  assert.throws(
    () => validatePayload({...backup, progress: {...backup.progress, schedulerVersion: 99}}),
    /Scheduler-Version/,
  );
});
