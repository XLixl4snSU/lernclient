import {
  FSRSVersion, GenSeedStrategyWithCardId, Rating, State, StrategyMode, createEmptyCard, fsrs,
} from './vendor/ts-fsrs.mjs';

export const SCHEDULER_VERSION = 2;
export const SUPPORTED_SCHEDULER_VERSIONS = new Set([1, SCHEDULER_VERSION]);
export const SCHEDULER_NAME = `FSRS 6 (${FSRSVersion.split(' ')[0]})`;
export const DEFAULT_SCHEDULER_SETTINGS = Object.freeze({
  requestRetentionPercent: 90,
  maximumIntervalDays: 36500,
  learningSteps: '1m, 10m',
  relearningSteps: '1m, 10m',
  enableFuzz: false,
  learnAheadMinutes: 15,
});

const RATING_TO_FSRS = Object.freeze({
  forgot: Rating.Again,
  partial: Rating.Hard,
  effort: Rating.Good,
  easy: Rating.Easy,
});
const STATE_TO_FSRS = Object.freeze({
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
});
const FSRS_TO_STATE = Object.freeze({
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
});

function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date : null;
}

function validNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

export function isValidStepList(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const steps = raw.split(/[\s,;]+/).map(step => step.trim().toLowerCase()).filter(Boolean);
  if (!steps.length || steps.length > 10 || steps.some(step => !/^\d+[mhd]$/.test(step))) return false;
  const factors = {m: 1, h: 60, d: 1440};
  const minutes = steps.map(step => Number(step.slice(0, -1)) * factors[step.slice(-1)]);
  const maximumMinutes = DEFAULT_SCHEDULER_SETTINGS.maximumIntervalDays * 1440;
  return minutes.every((duration, index) => duration > 0 && duration <= maximumMinutes
    && (index === 0 || duration > minutes[index - 1]));
}

function normalizedStepList(value, fallback) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const steps = raw.split(/[\s,;]+/).map(step => step.trim().toLowerCase()).filter(Boolean);
  if (!isValidStepList(value)) return fallback;
  return steps.join(', ');
}

function stepArray(value) {
  return value.split(',').map(step => step.trim()).filter(Boolean);
}

export function normalizeSchedulerSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    requestRetentionPercent: validNumber(
      source.requestRetentionPercent,
      DEFAULT_SCHEDULER_SETTINGS.requestRetentionPercent,
      70,
      97,
    ),
    maximumIntervalDays: Math.round(validNumber(
      source.maximumIntervalDays,
      DEFAULT_SCHEDULER_SETTINGS.maximumIntervalDays,
      30,
      36500,
    )),
    learningSteps: normalizedStepList(source.learningSteps, DEFAULT_SCHEDULER_SETTINGS.learningSteps),
    relearningSteps: normalizedStepList(source.relearningSteps, DEFAULT_SCHEDULER_SETTINGS.relearningSteps),
    enableFuzz: source.enableFuzz === true,
    learnAheadMinutes: Math.round(validNumber(
      source.learnAheadMinutes,
      DEFAULT_SCHEDULER_SETTINGS.learnAheadMinutes,
      0,
      120,
    )),
  };
}

function createFsrsScheduler(settings = {}, questionId = null) {
  const normalized = normalizeSchedulerSettings(settings);
  const scheduler = fsrs({
    request_retention: normalized.requestRetentionPercent / 100,
    maximum_interval: normalized.maximumIntervalDays,
    enable_fuzz: normalized.enableFuzz,
    enable_short_term: true,
    learning_steps: stepArray(normalized.learningSteps),
    relearning_steps: stepArray(normalized.relearningSteps),
  });
  if (normalized.enableFuzz && questionId) {
    scheduler.useStrategy(StrategyMode.SEED, GenSeedStrategyWithCardId('__questionId'));
  }
  return scheduler;
}

function fsrsState(state) {
  if (typeof state === 'number' && FSRS_TO_STATE[state]) return state;
  return STATE_TO_FSRS[state] ?? State.New;
}

function stateName(state) {
  return FSRS_TO_STATE[typeof state === 'number' ? state : fsrsState(state)] || 'new';
}

function toFsrsCard(card, nowDate = new Date()) {
  const source = card || {};
  const empty = createEmptyCard(nowDate);
  return {
    ...empty,
    due: parseDate(source.dueAt) || nowDate,
    stability: validNumber(source.stability, 0, 0, 36500),
    difficulty: validNumber(source.difficulty, 0, 0, 10),
    elapsed_days: validNumber(source.elapsedDays, 0, 0, 36500),
    scheduled_days: validNumber(source.scheduledDays ?? source.intervalDays, 0, 0, 36500),
    learning_steps: Math.max(0, Math.round(validNumber(source.learningSteps ?? source.stepIndex, 0, 0, 100))),
    reps: Math.max(0, Math.round(validNumber(source.repetitions, 0, 0, Number.MAX_SAFE_INTEGER))),
    lapses: Math.max(0, Math.round(validNumber(source.lapses, 0, 0, Number.MAX_SAFE_INTEGER))),
    state: fsrsState(source.state),
    last_review: parseDate(source.lastReviewedAt) || undefined,
  };
}

function fromFsrsCard(card, existingCard = {}, nowDate = new Date()) {
  const existing = existingCard || {};
  const state = stateName(card.state);
  return {
    scheduler: 'fsrs-6',
    state,
    dueAt: state === 'new' && card.reps === 0 ? null : iso(new Date(card.due)),
    lastReviewedAt: card.last_review ? iso(new Date(card.last_review)) : null,
    stability: Number(card.stability || 0),
    difficulty: Number(card.difficulty || 0),
    elapsedDays: Number(card.elapsed_days || 0),
    scheduledDays: Number(card.scheduled_days || 0),
    learningSteps: Number(card.learning_steps || 0),
    intervalDays: Number(card.scheduled_days || 0),
    repetitions: Number(card.reps || 0),
    lapses: Number(card.lapses || 0),
    suspended: Boolean(existing.suspended),
    createdAt: existing.createdAt || iso(nowDate),
    updatedAt: existing.updatedAt || iso(nowDate),
  };
}

export function defaultCard(nowDate = new Date()) {
  return fromFsrsCard(createEmptyCard(nowDate), {}, nowDate);
}

function serializedFsrsLog(log) {
  return {
    rating: log.rating,
    state: stateName(log.state),
    dueAt: iso(new Date(log.due)),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    learningSteps: log.learning_steps,
    reviewedAt: iso(new Date(log.review)),
  };
}

export async function scheduleReview(questionId, existingCard, rating, answerCorrect, nowDate = new Date(), schedulerSettings = {}) {
  const grade = RATING_TO_FSRS[rating];
  if (!grade) throw new Error('Ungültige Lernbewertung.');
  const scheduler = createFsrsScheduler(schedulerSettings, questionId);
  const previous = toFsrsCard(existingCard, nowDate);
  previous.__questionId = questionId;
  const previousState = stateName(previous.state);
  let retrievabilityBefore = null;
  if (previous.stability > 0 && previous.last_review) {
    try {
      retrievabilityBefore = scheduler.get_retrievability(previous, nowDate, false);
    } catch {
      retrievabilityBefore = null;
    }
  }
  const result = scheduler.next(previous, nowDate, grade);
  const reviewedAt = iso(nowDate);
  const nextCard = {
    ...fromFsrsCard(result.card, existingCard, nowDate),
    updatedAt: reviewedAt,
  };
  const review = {
    questionId,
    reviewedAt,
    rating,
    answerCorrect: answerCorrect ?? null,
    scheduler: 'fsrs-6',
    previousState,
    previousIntervalDays: Number(previous.scheduled_days || 0),
    nextState: nextCard.state,
    nextIntervalDays: nextCard.scheduledDays,
    nextDueAt: nextCard.dueAt,
    retrievabilityBefore,
    stability: nextCard.stability,
    difficulty: nextCard.difficulty,
    fsrsLog: serializedFsrsLog(result.log),
  };
  return {card: nextCard, review};
}

function approximateLegacyMemoryState(fsrsCard, legacyCard) {
  if (stateName(fsrsCard.state) === 'new') return;
  const interval = validNumber(legacyCard?.intervalDays, 0, 0, 36500);
  if (fsrsCard.stability <= 0 && interval > 0) fsrsCard.stability = Math.max(0.001, interval);
  if (fsrsCard.difficulty <= 0) {
    const ease = validNumber(legacyCard?.ease, 2.3, 1.3, 4);
    fsrsCard.difficulty = Math.min(10, Math.max(1, 11 - ease * 2.5));
  }
}

export function migrateLegacyCard(legacyCard, reviews = [], schedulerSettings = {}, nowDate = new Date()) {
  if (!legacyCard || legacyCard.scheduler === 'fsrs-6') {
    return {card: legacyCard || defaultCard(nowDate), migrated: false};
  }
  const scheduler = createFsrsScheduler(schedulerSettings);
  const history = reviews
    .map(review => ({...review, date: parseDate(review.reviewedAt), grade: RATING_TO_FSRS[review.rating]}))
    .filter(review => review.date && review.grade)
    .sort((a, b) => a.date - b.date);
  let reconstructed = createEmptyCard(history[0]?.date || parseDate(legacyCard.createdAt) || nowDate);
  for (const review of history) {
    try {
      reconstructed = scheduler.next(reconstructed, review.date, review.grade).card;
    } catch {
      // A damaged individual history entry must not make the whole backup unusable.
    }
  }
  reconstructed.state = fsrsState(legacyCard.state);
  reconstructed.due = parseDate(legacyCard.dueAt) || reconstructed.due;
  reconstructed.last_review = parseDate(legacyCard.lastReviewedAt) || reconstructed.last_review;
  reconstructed.reps = Math.max(reconstructed.reps, Number(legacyCard.repetitions || 0));
  reconstructed.lapses = Math.max(reconstructed.lapses, Number(legacyCard.lapses || 0));
  reconstructed.scheduled_days = validNumber(legacyCard.intervalDays, reconstructed.scheduled_days, 0, 36500);
  reconstructed.learning_steps = Math.max(0, Number(legacyCard.stepIndex || reconstructed.learning_steps || 0));
  approximateLegacyMemoryState(reconstructed, legacyCard);
  return {
    card: fromFsrsCard(reconstructed, legacyCard, nowDate),
    migrated: true,
  };
}

export function migrateWorkspaceScheduler(workspace, nowDate = new Date()) {
  if (!workspace) return {workspace, migrated: false};
  const previousSettings = workspace.settings || {};
  const previousSchedulerSettings = previousSettings.scheduler;
  const schedulerSettings = normalizeSchedulerSettings(previousSchedulerSettings);
  const hasLegacySchedulerSettings = previousSchedulerSettings && [
    'firstLearningMinutes', 'secondLearningHours', 'thirdLearningDays',
    'easyIntervalDays', 'relearningMinutes',
  ].some(key => Object.hasOwn(previousSchedulerSettings, key));
  const reviewsByQuestion = new Map();
  for (const review of workspace.reviews || []) {
    const list = reviewsByQuestion.get(review.questionId) || [];
    list.push(review);
    reviewsByQuestion.set(review.questionId, list);
  }
  let migrated = workspace.schedulerVersion !== SCHEDULER_VERSION;
  const cards = {};
  for (const [questionId, card] of Object.entries(workspace.cards || {})) {
    const result = migrateLegacyCard(card, reviewsByQuestion.get(questionId) || [], schedulerSettings, nowDate);
    cards[questionId] = result.card;
    migrated ||= result.migrated;
  }
  if (JSON.stringify(previousSchedulerSettings || {}) !== JSON.stringify(schedulerSettings)) migrated = true;
  const settings = {...previousSettings, scheduler: schedulerSettings};
  if (hasLegacySchedulerSettings && !settings.legacySchedulerV1) {
    settings.legacySchedulerV1 = {...previousSchedulerSettings};
  }
  return {
    workspace: {
      ...workspace,
      schedulerVersion: SCHEDULER_VERSION,
      cards,
      settings,
    },
    migrated,
  };
}

export function learningStats(workspace, now = new Date()) {
  const questions = workspace?.questions || [];
  const cards = workspace?.cards || {};
  const states = {new: 0, learning: 0, review: 0, relearning: 0};
  let due = 0;
  let suspended = 0;
  for (const question of questions) {
    const card = cards[question.id] || defaultCard(now);
    const state = card.state || 'new';
    states[state] = (states[state] || 0) + 1;
    if (card.suspended) suspended += 1;
    else if (state !== 'new' && card.dueAt && new Date(card.dueAt) <= now) due += 1;
  }
  const graded = (workspace?.reviews || []).filter(review => review.answerCorrect !== null && review.answerCorrect !== undefined);
  const correct = graded.filter(review => review.answerCorrect === true).length;
  return {
    total: questions.length,
    new: states.new || 0,
    due,
    learning: states.learning || 0,
    review: states.review || 0,
    relearning: states.relearning || 0,
    suspended,
    reviews: (workspace?.reviews || []).length,
    accuracy: graded.length ? correct / graded.length * 100 : null,
  };
}

function seededOrder(seed, questionId) {
  const value = `${seed}:${questionId}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function nextQuestion(workspace, requestedId = null, now = new Date(), sessionSeed = '') {
  if (!workspace) return null;
  const byId = new Map(workspace.questions.map(question => [question.id, question]));
  if (requestedId && byId.has(requestedId)) return byId.get(requestedId);
  const compareSessionOrder = (a, b) => seededOrder(sessionSeed, a.id) - seededOrder(sessionSeed, b.id)
    || String(a.id).localeCompare(String(b.id));
  const stateOrder = {relearning: 0, learning: 1, review: 2};
  const compareDue = (a, b) => {
    const ca = workspace.cards[a.id];
    const cb = workspace.cards[b.id];
    const dueWindowA = Math.floor(new Date(ca.dueAt).getTime() / 3600000);
    const dueWindowB = Math.floor(new Date(cb.dueAt).getTime() / 3600000);
    return (stateOrder[ca.state] ?? 9) - (stateOrder[cb.state] ?? 9)
      || dueWindowA - dueWindowB
      || compareSessionOrder(a, b);
  };
  const due = workspace.questions
    .filter(question => {
      const card = workspace.cards?.[question.id];
      return card && !card.suspended && card.state !== 'new' && card.dueAt && new Date(card.dueAt) <= now;
    })
    .sort(compareDue);
  if (due.length) return due[0];
  const newQuestions = workspace.questions
    .filter(question => {
      const card = workspace.cards?.[question.id];
      return !card || (!card.suspended && card.state === 'new');
    })
    .sort(compareSessionOrder);
  if (newQuestions.length) return newQuestions[0];
  const settings = normalizeSchedulerSettings(workspace.settings?.scheduler);
  if (settings.learnAheadMinutes <= 0) return null;
  const learnAheadCutoff = new Date(now.getTime() + settings.learnAheadMinutes * 60000);
  return workspace.questions
    .filter(question => {
      const card = workspace.cards?.[question.id];
      return card && !card.suspended && ['learning', 'relearning'].includes(card.state)
        && card.dueAt && new Date(card.dueAt) <= learnAheadCutoff;
    })
    .sort(compareDue)[0] || null;
}
