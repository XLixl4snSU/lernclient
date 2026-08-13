export const LEARNING_STEPS_SECONDS = [30 * 60, 2 * 60 * 60, 2 * 24 * 60 * 60];
export const RELEARNING_STEPS_SECONDS = [10 * 60];
export const STARTING_EASE = 2.30;
export const MINIMUM_EASE = 1.30;
export const EASY_BONUS = 1.30;
export const LAPSE_INTERVAL_MULTIPLIER = 0.10;

function iso(date) { return date.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function parseDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.valueOf()) ? date : null; }

async function deterministicFuzz(questionId, repetitions) {
  const data = new TextEncoder().encode(`${questionId}:${repetitions}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const integer = digest[0] * 256 + digest[1];
  return 0.95 + (integer / 65535) * 0.10;
}

export function defaultCard() {
  const now = new Date().toISOString();
  return {
    state: 'new', stepIndex: 0, ease: STARTING_EASE, intervalDays: 0,
    dueAt: null, lastReviewedAt: null, repetitions: 0, lapses: 0,
    suspended: false, createdAt: now, updatedAt: now,
  };
}

export async function scheduleReview(questionId, existingCard, rating, answerCorrect, nowDate = new Date()) {
  if (!['forgot', 'partial', 'effort', 'easy'].includes(rating)) throw new Error('Ungültige Lernbewertung.');
  const card = existingCard ? {...defaultCard(), ...existingCard} : defaultCard();
  const previousState = card.state || 'new';
  let stepIndex = Number(card.stepIndex || 0);
  let ease = Number(card.ease || STARTING_EASE);
  let intervalDays = Number(card.intervalDays || 0);
  let repetitions = Number(card.repetitions || 0);
  let lapses = Number(card.lapses || 0);
  const previousDue = parseDate(card.dueAt);
  let nextState = previousState;
  let nextStep = stepIndex;
  let nextInterval = intervalDays;
  let delay;

  if (['new', 'learning'].includes(previousState)) {
    const current = Math.max(0, Math.min(stepIndex, LEARNING_STEPS_SECONDS.length - 1));
    if (rating === 'forgot') {
      nextState = 'learning'; nextStep = 0; delay = LEARNING_STEPS_SECONDS[0];
    } else if (rating === 'partial') {
      nextState = 'learning'; nextStep = current; delay = Math.max(5 * 60, Math.floor(LEARNING_STEPS_SECONDS[current] / 2));
    } else if (rating === 'effort') {
      if (current + 1 < LEARNING_STEPS_SECONDS.length) {
        nextState = 'learning'; nextStep = current + 1; delay = LEARNING_STEPS_SECONDS[current + 1];
      } else {
        nextState = 'review'; nextStep = 0;
        nextInterval = Math.max(1, (LEARNING_STEPS_SECONDS[current] / 86400) * ease);
        delay = Math.floor(nextInterval * 86400);
      }
    } else {
      nextState = 'review'; nextStep = 0; nextInterval = 4; ease += 0.15; delay = Math.floor(nextInterval * 86400);
    }
  } else if (previousState === 'relearning') {
    if (rating === 'forgot') {
      nextState = 'relearning'; nextStep = 0; delay = RELEARNING_STEPS_SECONDS[0];
    } else if (rating === 'partial') {
      nextState = 'relearning'; nextStep = 0; delay = Math.max(5 * 60, Math.floor(RELEARNING_STEPS_SECONDS[0] / 2));
    } else {
      nextState = 'review'; nextStep = 0;
      if (rating === 'easy') { nextInterval = Math.max(1, intervalDays * EASY_BONUS); ease += 0.15; }
      else nextInterval = Math.max(1, intervalDays);
      delay = Math.floor(nextInterval * 86400);
    }
  } else {
    let daysLate = 0;
    if (previousDue && nowDate > previousDue) daysLate = (nowDate - previousDue) / 86400000;
    if (rating === 'forgot') {
      ease = Math.max(MINIMUM_EASE, ease - 0.20); lapses += 1;
      nextInterval = Math.max(1, intervalDays * LAPSE_INTERVAL_MULTIPLIER);
      nextState = 'relearning'; nextStep = 0; delay = RELEARNING_STEPS_SECONDS[0];
    } else {
      let factor, divider;
      if (rating === 'partial') { factor = 1.20; divider = 4; ease = Math.max(MINIMUM_EASE, ease - 0.15); }
      else if (rating === 'effort') { factor = ease; divider = 2; }
      else { factor = ease * EASY_BONUS; divider = 1; ease += 0.15; }
      const baseInterval = Math.max(intervalDays, 1) + daysLate / divider;
      repetitions += 1;
      nextInterval = Math.max(1, baseInterval * factor);
      nextInterval *= await deterministicFuzz(questionId, repetitions);
      nextInterval = Math.round(nextInterval * 1000) / 1000;
      nextState = 'review'; nextStep = 0; delay = Math.floor(nextInterval * 86400);
    }
  }

  ease = Math.max(MINIMUM_EASE, Math.round(ease * 1000) / 1000);
  if (['new', 'learning', 'relearning'].includes(previousState)) repetitions += 1;
  const dueAt = iso(new Date(nowDate.getTime() + delay * 1000));
  const reviewedAt = iso(nowDate);
  const nextCard = {
    ...card, state: nextState, stepIndex: nextStep, ease, intervalDays: nextInterval,
    dueAt, lastReviewedAt: reviewedAt, repetitions, lapses, suspended: false,
    updatedAt: reviewedAt,
  };
  const review = {
    questionId, reviewedAt, rating, answerCorrect: answerCorrect ?? null,
    previousState, previousIntervalDays: intervalDays,
    nextState, nextIntervalDays: nextInterval, nextDueAt: dueAt,
  };
  return {card: nextCard, review};
}

export function learningStats(workspace, now = new Date()) {
  const questions = workspace?.questions || [];
  const cards = workspace?.cards || {};
  const states = {new: 0, learning: 0, review: 0, relearning: 0};
  let due = 0, suspended = 0;
  for (const question of questions) {
    const card = cards[question.id] || defaultCard();
    const state = card.state || 'new';
    states[state] = (states[state] || 0) + 1;
    if (card.suspended) suspended += 1;
    else if (state !== 'new' && card.dueAt && new Date(card.dueAt) <= now) due += 1;
  }
  const graded = (workspace?.reviews || []).filter(review => review.answerCorrect !== null && review.answerCorrect !== undefined);
  const correct = graded.filter(review => review.answerCorrect === true).length;
  return {
    total: questions.length, new: states.new || 0, due,
    learning: states.learning || 0, review: states.review || 0, relearning: states.relearning || 0,
    suspended, reviews: (workspace?.reviews || []).length,
    accuracy: graded.length ? correct / graded.length * 100 : null,
  };
}

export function nextQuestion(workspace, requestedId = null, now = new Date()) {
  if (!workspace) return null;
  const byId = new Map(workspace.questions.map(question => [question.id, question]));
  if (requestedId && byId.has(requestedId)) return byId.get(requestedId);
  const due = workspace.questions
    .filter(question => {
      const card = workspace.cards?.[question.id];
      return card && !card.suspended && card.state !== 'new' && card.dueAt && new Date(card.dueAt) <= now;
    })
    .sort((a, b) => {
      const order = {relearning: 0, learning: 1, review: 2};
      const ca = workspace.cards[a.id], cb = workspace.cards[b.id];
      return (order[ca.state] ?? 9) - (order[cb.state] ?? 9) || String(ca.dueAt).localeCompare(String(cb.dueAt));
    });
  if (due.length) return due[0];
  return workspace.questions.find(question => {
    const card = workspace.cards?.[question.id];
    return !card || (!card.suspended && card.state === 'new');
  }) || null;
}

export function ratingLabel(rating) {
  return ({forgot: 'Vergessen', partial: 'Teilweise', effort: 'Mit Anstrengung', easy: 'Leicht'})[rating] || rating;
}
