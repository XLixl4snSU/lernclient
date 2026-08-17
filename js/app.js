import {
  getActiveWorkspace, importBankPayload, importBackupPayload, saveWorkspace,
  listWorkspaces, setActiveBankId, deleteWorkspace,
} from './storage.js';
import {BANK_FORMAT, BACKUP_FORMAT, readLearningFile, downloadBackup} from './formats.js';
import {
  DEFAULT_SCHEDULER_SETTINGS, SCHEDULER_NAME, isValidStepList, learningStats,
  nextQuestion, normalizeSchedulerSettings, scheduleReview,
} from './scheduler.js';
import {
  renderInteraction, collectResponse, evaluateAnswer, renderFeedback,
  displayPromptText, renderCorrectSolution, wireQuestionInteractions, searchableText,
  setAssetStore, renderAssetsForRoles,
} from './questions.js';

const app = document.getElementById('app');
const nav = document.getElementById('main-nav');
const bankInput = document.getElementById('bank-file-input');
const backupInput = document.getElementById('backup-file-input');
let workspace = null;
let checkedQuestion = null;
let flash = null;
let learningSessionSeed = null;
let activeQuestionPresentation = null;

function createLearningSessionSeed() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return [...values].map(value => value.toString(16)).join('-');
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function pointsLabel(points) {
  if (points === null || points === undefined) return 'Ohne Punktzahl';
  return `${points} ${Number(points) === 1 ? 'Punkt' : 'Punkte'}`;
}

function typeLabel(type) {
  return ({single_choice:'Single Choice', multiple_choice:'Multiple Choice', choice_matrix:'Matrix', cloze:'Lückentext', matching:'Zuordnung', ordering:'Reihenfolge', image_drag_drop:'Drag & Drop auf Bild', drag_drop:'Drag & Drop (Legacy)'})[type] || type;
}

function stateLabel(state) {
  return ({new:'Neu', learning:'Lernen', review:'Wiederholung', relearning:'Wiederlernen'})[state] || state;
}

function renderQuestionAssets(question) {
  return renderAssetsForRoles(question, new Set(['prompt']));
}

function formatDue(value) {
  if (!value) return '–';
  const date = new Date(value);
  return new Intl.DateTimeFormat('de-DE', {dateStyle:'medium', timeStyle:'short'}).format(date);
}

function formatReviewDelay(dueAt, now = new Date()) {
  const due = new Date(dueAt);
  const seconds = Math.max(0, (due - now) / 1000);
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))} Min.`;
  if (seconds < 86400) {
    const hours = Math.round(seconds / 360) / 10;
    return `in ${new Intl.NumberFormat('de-DE', {maximumFractionDigits:1}).format(hours)} Std.`;
  }
  const days = seconds / 86400;
  const roundedDays = days < 14 ? Math.round(days * 10) / 10 : Math.round(days);
  const value = new Intl.NumberFormat('de-DE', {maximumFractionDigits:1}).format(roundedDays);
  return `in ${value} ${roundedDays === 1 ? 'Tag' : 'Tagen'}`;
}

function datetimeLocalValue(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function setFlash(message, kind = 'success') {
  flash = {message, kind};
}

function flashHtml() {
  if (!flash) return '';
  const current = flash; flash = null;
  return `<div class="flash ${current.kind === 'error' ? 'error' : ''}" role="status">${escapeHtml(current.message)}</div>`;
}

function renderNav() {
  const hasBank = Boolean(workspace);
  const links = hasBank ? [
    ['#/', 'Übersicht', 'home'], ['#/learn', 'Lernen', 'learn'], ['#/questions', 'Fragen', 'questions'], ['#/settings', 'Einstellungen', 'settings'],
  ] : [['#/', 'Start', 'home']];
  const hash = location.hash || '#/';
  nav.innerHTML = links.map(([href,label,key]) => `<a href="${href}" class="${hash.startsWith(href) && (href !== '#/' || hash === '#/') ? 'active' : ''}">${label}</a>`).join('');
}

function shell(content) {
  app.innerHTML = flashHtml() + content;
  renderNav();
}

function noBankScreen() {
  shell(`<section class="hero"><div><div class="eyebrow">Statischer Lernclient</div><h1>Lerndatenbank</h1><p class="lead">Öffne eine <code>.lernbank</code> aus deiner Lerngruppe oder stelle ein persönliches <code>.lernbackup</code> wieder her. Die Dateien werden nur in deinem Browser verarbeitet.</p></div></section>
  <section class="import-grid">
    <button class="import-card" data-open-bank><span class="import-icon">＋</span><strong>Fragensammlung öffnen</strong><span>.lernbank importieren</span></button>
    <button class="import-card" data-open-backup><span class="import-icon">↥</span><strong>Backup wiederherstellen</strong><span>Mit bestehendem Lernstand weiterlernen</span></button>
  </section>
  <section class="card privacy-card backup-warning"><h2>Wichtig: Keine automatische Sicherung</h2><p>Fragen und Lernfortschritt werden ausschließlich in diesem Browser gespeichert. Es gibt kein Nutzerkonto, keine Cloud-Synchronisierung und keine automatisch erstellte Backup-Datei.</p><p><strong>Sobald du mit dem Lernen beginnst, musst du deinen Lernstand selbst als <code>.lernbackup</code> herunterladen.</strong> Nur damit kannst du ihn nach gelöschten Browserdaten oder auf einem anderen Gerät wiederherstellen.</p></section>`);
  wireFileButtons();
}

function dashboard() {
  if (!workspace) return noBankScreen();
  const stats = learningStats(workspace);
  const accuracy = stats.accuracy === null ? '–' : `${Math.round(stats.accuracy)} %`;
  shell(`<section class="hero"><div><div class="eyebrow">${escapeHtml(workspace.bank.name)}</div><h1>Weiterlernen.</h1><p class="lead">Revision ${escapeHtml(String(workspace.bank.revision || '').slice(0,12) || '–')} · ${workspace.questions.length} Fragen lokal geladen.</p></div><div class="hero-actions"><a class="button" href="#/learn/session">Lernsitzung starten</a></div></section>
  <section class="grid metrics"><div class="card metric warning"><div class="metric-value">${stats.due}</div><div class="metric-label">jetzt fällig</div></div><div class="card metric"><div class="metric-value">${stats.new}</div><div class="metric-label">noch neu</div></div><div class="card metric good"><div class="metric-value">${stats.review}</div><div class="metric-label">im Wiederholungsmodus</div></div><div class="card metric"><div class="metric-value">${accuracy}</div><div class="metric-label">Antwortgenauigkeit</div></div></section>
  <section class="grid two-column"><div class="card"><h2>Lernstand</h2><p><strong>${stats.learning}</strong> in der Lernphase · <strong>${stats.relearning}</strong> im Wiederlernen · <strong>${stats.reviews}</strong> Bewertungen gespeichert.</p><p class="note">Fällige Wiederholungen werden vor neuen Fragen abgearbeitet.</p></div><div class="card backup-warning"><h2>Wichtig: Fortschritt selbst sichern</h2><p>Es gibt keine automatische Sicherung. Ohne heruntergeladenes Backup kann dein Lernstand beim Löschen der Browserdaten oder beim Gerätewechsel verloren gehen.</p><p><strong>Lade nach jeder Lernsitzung ein aktuelles <code>.lernbackup</code> herunter.</strong></p><div class="button-row"><button class="button secondary" data-open-bank>Sammlung aktualisieren</button><button class="button" data-download-backup>Backup jetzt herunterladen</button></div></div></section>`);
  wireFileButtons();
}

function learnHome() {
  if (!workspace) return noBankScreen();
  const stats = learningStats(workspace);
  const next = nextQuestion(workspace);
  shell(`<section class="hero"><div><div class="eyebrow">Spaced Repetition</div><h1>Lernen</h1><p class="lead">Beantworte die Aufgabe wie im Online-Test, prüfe sie und bewerte anschließend, wie gut du sie erinnern konntest.</p></div><div class="hero-actions">${next ? '<a class="button" href="#/learn/session">Lernsitzung starten</a>' : ''}</div></section>
  <section class="grid metrics"><div class="card metric warning"><div class="metric-value">${stats.due}</div><div class="metric-label">jetzt fällig</div></div><div class="card metric"><div class="metric-value">${stats.new}</div><div class="metric-label">noch neu</div></div><div class="card metric good"><div class="metric-value">${stats.review}</div><div class="metric-label">Wiederholungsmodus</div></div><div class="card metric"><div class="metric-value">${stats.reviews}</div><div class="metric-label">Bewertungen</div></div></section>
  ${next ? '' : '<div class="card empty"><div class="empty-mark">✓</div><h2>Aktuell nichts zu lernen</h2><p class="note">Es gibt weder fällige Wiederholungen noch neue Fragen.</p></div>'}
  <section class="card backup-reminder backup-warning"><div><h2>Wichtig: Nach dem Lernen Backup herunterladen</h2><p>Dein Lernstand befindet sich nur in diesem Browser. Er wird weder in einer Cloud noch automatisch als Datei gesichert. <strong>Ohne eigenes Backup kann der gesamte Fortschritt beim Löschen der Browserdaten oder auf einem anderen Gerät fehlen.</strong></p></div><button class="button" data-download-backup>Backup jetzt herunterladen</button></section>`);
  wireFileButtons();
}

function learningQuestion(requestedId = null) {
  if (!workspace) return noBankScreen();
  learningSessionSeed ||= createLearningSessionSeed();
  const question = nextQuestion(workspace, requestedId, new Date(), learningSessionSeed);
  if (!question) return learnHome();
  const card = workspace.cards?.[question.id];
  const checked = checkedQuestion?.id === question.id ? checkedQuestion : null;
  if (!activeQuestionPresentation || activeQuestionPresentation.questionId !== question.id) {
    activeQuestionPresentation = {questionId: question.id, seed: createLearningSessionSeed()};
  }
  const presentationSeed = checked?.presentationSeed || activeQuestionPresentation.seed;
  const response = checked?.response || {};
  const result = checked?.result || null;
  const status = card?.state || 'new';
  shell(`<section class="learning-shell">
    <div class="learning-topline"><div class="question-meta"><span class="question-meta-strong">Aufgabe · ${escapeHtml(pointsLabel(question.points))}</span><span class="chip">${escapeHtml(typeLabel(question.type))}</span><span class="chip">${escapeHtml(stateLabel(status))}</span>${card?.dueAt ? `<span class="chip">fällig ${escapeHtml(formatDue(card.dueAt))}</span>` : ''}</div><a href="#/learn" class="quiet-link">Sitzung verlassen</a></div>
    <article class="card learning-card"><div class="question-instruction">${escapeHtml(question.instruction || '')}</div><div class="question-prompt">${escapeHtml(displayPromptText(question) || '(Frage ohne Text)')}</div>${renderQuestionAssets(question)}
      <div id="question-interaction">${renderInteraction(question, response, result, presentationSeed)}</div>${renderFeedback(question, result)}
      ${result ? renderRatings(question, result) : '<div class="learning-actions"><button id="check-answer" class="button" type="button">Antwort prüfen</button></div>'}
    </article></section>`);
  const interaction = document.getElementById('question-interaction');
  wireQuestionInteractions(interaction);
  if (!result) {
    document.getElementById('check-answer')?.addEventListener('click', () => {
      const responseNow = collectResponse(interaction, question);
      checkedQuestion = {id: question.id, response: responseNow, result: evaluateAnswer(question, responseNow), presentationSeed};
      learningQuestion(question.id);
    });
  } else {
    updateRatingPreviews(question, result);
    document.querySelectorAll('[data-rating]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      const rating = button.dataset.rating;
      const scheduled = await scheduleReview(
        question.id, workspace.cards?.[question.id], rating, result.correct,
        new Date(), workspace.settings?.scheduler,
      );
      workspace.cards = {...(workspace.cards || {}), [question.id]: scheduled.card};
      workspace.reviews = [...(workspace.reviews || []), scheduled.review];
      await saveWorkspace(workspace);
      checkedQuestion = null;
      activeQuestionPresentation = null;
      learningQuestion();
    }));
  }
}

async function updateRatingPreviews(question, result) {
  const now = new Date();
  await Promise.all([...document.querySelectorAll('[data-rating]')].map(async button => {
    const output = button.querySelector('[data-rating-due]');
    if (!output) return;
    try {
      const scheduled = await scheduleReview(
        question.id, workspace.cards?.[question.id], button.dataset.rating, result.correct,
        now, workspace.settings?.scheduler,
      );
      const relativeDue = formatReviewDelay(scheduled.card.dueAt, now);
      const exactDue = formatDue(scheduled.card.dueAt);
      output.textContent = relativeDue;
      output.title = `Wiederholung am ${exactDue}`;
      button.setAttribute('aria-label', `${button.querySelector('strong')?.textContent || ''}, Wiederholung ${relativeDue}, am ${exactDue}`);
    } catch {
      output.textContent = 'Termin nicht verfügbar';
    }
  }));
}

function renderRatings(question, result) {
  return `<div class="rating-panel"><div><strong>Wie gut konntest du dich erinnern?</strong><div class="note">Die fachliche Auswertung (${result.earned}/${result.total || 1}) wird getrennt von deiner Erinnerungsbewertung gespeichert.</div></div><div class="rating-grid">
    <button type="button" class="rating forgot" data-rating="forgot"><strong>Vergessen</strong><span class="rating-due" data-rating-due>Termin wird berechnet …</span><span>zurück in die Lernphase</span></button>
    <button type="button" class="rating partial" data-rating="partial"><strong>Teilweise</strong><span class="rating-due" data-rating-due>Termin wird berechnet …</span><span>kurzes Intervall</span></button>
    <button type="button" class="rating effort" data-rating="effort"><strong>Mit Anstrengung</strong><span class="rating-due" data-rating-due>Termin wird berechnet …</span><span>normales Intervall</span></button>
    <button type="button" class="rating easy" data-rating="easy"><strong>Leicht</strong><span class="rating-due" data-rating-due>Termin wird berechnet …</span><span>größeres Intervall</span></button>
  </div></div>`;
}

function renderQuestionBrowserItem(question) {
  const card = workspace.cards?.[question.id];
  return `<article class="browser-item"><div class="browser-item-head"><div><h3 class="browser-item-title">${escapeHtml(displayPromptText(question) || '(Frage ohne Text)')}</h3><div class="browser-item-meta"><span class="chip">${escapeHtml(typeLabel(question.type))}</span><span class="chip">${escapeHtml(pointsLabel(question.points))}</span><span class="chip">${escapeHtml(stateLabel(card?.state || 'new'))}</span>${card?.dueAt ? `<span class="chip">fällig ${escapeHtml(formatDue(card.dueAt))}</span>` : ''}</div></div><a class="button secondary small" href="#/question/${encodeURIComponent(question.id)}">Öffnen</a></div>
    <details class="browser-solution"><summary>Korrekte Lösung anzeigen</summary><div class="browser-solution-content">${renderCorrectSolution(question)}</div></details></article>`;
}

function renderQuestionProgressControls(question) {
  const card = workspace.cards?.[question.id];
  const reviews = (workspace.reviews || []).filter(review => review.questionId === question.id).length;
  const hasProgress = Boolean(card) || reviews > 0;
  const dueEditor = card?.dueAt && card.state !== 'new' ? `<form class="question-due-form" data-due-form="${escapeHtml(question.id)}"><div class="filter-field"><label>Fälligkeit</label><input name="dueAt" type="datetime-local" required value="${escapeHtml(datetimeLocalValue(card.dueAt))}"></div><div class="button-row"><button class="button small" type="submit">Termin speichern</button><button class="button secondary small" type="button" data-due-now="${escapeHtml(question.id)}">Jetzt fällig</button></div></form>` : '<p class="note">Für diese neue Frage gibt es noch keinen Wiederholungstermin. Ein Termin entsteht nach der ersten Bewertung im Lernmodus.</p>';
  return `<div class="question-progress-content"><div class="question-progress-summary"><span><strong>Status:</strong> ${escapeHtml(stateLabel(card?.state || 'new'))}</span><span><strong>Fälligkeit:</strong> ${escapeHtml(formatDue(card?.dueAt))}</span><span><strong>Bewertungen:</strong> ${reviews}</span></div>${dueEditor}<div class="question-reset-row"><div><strong>Lernstand dieser Frage zurücksetzen</strong><p class="note">Entfernt Termin, Scheduler-Zustand und Bewertungshistorie nur für diese Frage.</p></div><button class="button danger small" type="button" data-reset-question="${escapeHtml(question.id)}" ${hasProgress ? '' : 'disabled'}>Zurücksetzen</button></div></div>`;
}

function wireQuestionProgressControls(container, rerender) {
  if (!container) return;
  container.querySelectorAll('[data-due-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const questionId = form.dataset.dueForm;
    const card = workspace.cards?.[questionId];
    const due = new Date(new FormData(form).get('dueAt'));
    if (!card || Number.isNaN(due.valueOf())) {
      setFlash('Der Wiederholungstermin konnte nicht gespeichert werden.', 'error');
      return rerender();
    }
    workspace.cards = {...workspace.cards, [questionId]: {...card, dueAt: due.toISOString(), updatedAt: new Date().toISOString()}};
    await saveWorkspace(workspace);
    setFlash('Fälligkeit der Frage gespeichert.');
    rerender();
  }));
  container.querySelectorAll('[data-due-now]').forEach(button => button.addEventListener('click', async () => {
    const questionId = button.dataset.dueNow;
    const card = workspace.cards?.[questionId];
    if (!card) return;
    const now = new Date().toISOString();
    workspace.cards = {...workspace.cards, [questionId]: {...card, dueAt: now, updatedAt: now}};
    await saveWorkspace(workspace);
    setFlash('Die Frage ist jetzt fällig.');
    rerender();
  }));
  container.querySelectorAll('[data-reset-question]').forEach(button => button.addEventListener('click', async () => {
    const questionId = button.dataset.resetQuestion;
    const question = workspace.questions.find(item => item.id === questionId);
    if (!confirm(`Lernstand für „${question?.prompt?.text || 'diese Frage'}“ wirklich zurücksetzen? Termin und Bewertungshistorie dieser Frage werden gelöscht.`)) return;
    const cards = {...(workspace.cards || {})};
    delete cards[questionId];
    workspace.cards = cards;
    workspace.reviews = (workspace.reviews || []).filter(review => review.questionId !== questionId);
    await saveWorkspace(workspace);
    setFlash('Lernstand der Frage zurückgesetzt.');
    rerender();
  }));
}

function questionsBrowser() {
  if (!workspace) return noBankScreen();
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const q = params.get('q') || '';
  const type = params.get('type') || '';
  const points = params.get('points') || '';
  const state = params.get('state') || '';
  const initialPage = Math.max(1, Number(params.get('page') || 1) || 1);
  const types = [...new Set(workspace.questions.map(question => question.type))].sort();
  const pointValues = [...new Set(workspace.questions.map(question => question.points).filter(value => value !== null && value !== undefined))].sort((a,b)=>a-b);
  shell(`<section class="hero"><div><div class="eyebrow">Nachschlagen</div><h1>Fragenbrowser</h1><p class="lead">Durchsuche Fragen, Aufgabenstellungen und sämtliche Lösungstexte deiner lokal geladenen Fragensammlung.</p></div></section>
  <section class="card"><form id="question-search" class="question-browser-form"><div class="filter-field search-wide"><label for="q">Freie Suche</label><input id="q" type="search" name="q" value="${escapeHtml(q)}" placeholder="Frage oder Lösung durchsuchen …" autocomplete="off"><span class="note">Ergebnisse werden während der Eingabe aktualisiert.</span></div><div class="filter-field"><label for="type">Fragentyp</label><select id="type" name="type"><option value="">Alle Typen</option>${types.map(value=>`<option value="${escapeHtml(value)}" ${value===type?'selected':''}>${escapeHtml(typeLabel(value))}</option>`).join('')}</select></div><div class="filter-field"><label for="points">Punktzahl</label><select id="points" name="points"><option value="">Alle Punktzahlen</option>${pointValues.map(value=>`<option value="${value}" ${String(value)===points?'selected':''}>${escapeHtml(pointsLabel(value))}</option>`).join('')}<option value="none" ${points==='none'?'selected':''}>Ohne Punktzahl</option></select></div><div class="filter-field"><label for="state">Lernstand</label><select id="state" name="state"><option value="">Alle Lernstände</option><option value="new" ${state==='new'?'selected':''}>Neu</option><option value="learning" ${state==='learning'?'selected':''}>Lernen</option><option value="review" ${state==='review'?'selected':''}>Wiederholung</option><option value="relearning" ${state==='relearning'?'selected':''}>Wiederlernen</option><option value="due" ${state==='due'?'selected':''}>Jetzt fällig</option></select></div><button class="button secondary search-reset-button" type="button" data-reset-search>Zurücksetzen</button></form></section>
  <div id="browser-summary" class="browser-summary"></div><section id="browser-list" class="browser-list"></section><div id="browser-pager" class="browser-pager"></div>`);

  const form = document.getElementById('question-search');
  const list = document.getElementById('browser-list');
  const summary = document.getElementById('browser-summary');
  const pager = document.getElementById('browser-pager');
  const pageSize = 40;
  let currentPage = initialPage;
  let inputTimer = null;

  const renderResults = (requestedPage = 1) => {
    const data = new FormData(form);
    const currentQ = String(data.get('q') || '');
    const currentType = String(data.get('type') || '');
    const currentPoints = String(data.get('points') || '');
    const currentState = String(data.get('state') || '');
    const terms = currentQ.trim().toLocaleLowerCase('de').split(/\s+/).filter(Boolean);
    const items = workspace.questions.filter(question => {
      if (currentType && question.type !== currentType) return false;
      if (currentPoints && (currentPoints === 'none' ? question.points !== null && question.points !== undefined : String(question.points) !== currentPoints)) return false;
      const card = workspace.cards?.[question.id];
      const questionState = card?.state || 'new';
      if (currentState === 'due') {
        if (!card || card.suspended || questionState === 'new' || !card.dueAt || new Date(card.dueAt) > new Date()) return false;
      } else if (currentState && questionState !== currentState) return false;
      const text = searchableText(question);
      return terms.every(term => text.includes(term.normalize('NFKC').toLocaleLowerCase('de')));
    });
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    currentPage = Math.min(Math.max(1, requestedPage), pageCount);
    const startIndex = (currentPage - 1) * pageSize;
    const pageItems = items.slice(startIndex, startIndex + pageSize);
    const end = Math.min(startIndex + pageItems.length, items.length);
    list.innerHTML = pageItems.map(renderQuestionBrowserItem).join('') || '<div class="card empty"><div class="empty-mark">?</div><h2>Keine Treffer</h2><p class="note">Passe Suche oder Filter an.</p></div>';
    summary.innerHTML = `<span>${items.length} Treffer · angezeigt ${items.length ? startIndex + 1 : 0}–${end}</span>`;
    pager.innerHTML = `${currentPage > 1 ? '<button class="button secondary small" type="button" data-browser-page="previous">← Zurück</button>' : '<span></span>'}${end < items.length ? '<button class="button secondary small" type="button" data-browser-page="next">Weiter →</button>' : '<span></span>'}`;
    const nextParams = new URLSearchParams();
    if (currentQ) nextParams.set('q', currentQ);
    if (currentType) nextParams.set('type', currentType);
    if (currentPoints) nextParams.set('points', currentPoints);
    if (currentState) nextParams.set('state', currentState);
    if (currentPage > 1) nextParams.set('page', String(currentPage));
    history.replaceState(null, '', '#/questions' + (nextParams.toString() ? `?${nextParams}` : ''));
    list.querySelectorAll('.browser-solution').forEach(details => details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.wired) return;
      details.dataset.wired = '1';
      wireQuestionInteractions(details.querySelector('.browser-solution-content'));
      window.dispatchEvent(new Event('resize'));
    }));
  };

  form.addEventListener('submit', event => { event.preventDefault(); renderResults(1); });
  form.querySelector('input[name="q"]')?.addEventListener('input', () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => renderResults(1), 120);
  });
  form.querySelectorAll('select').forEach(select => select.addEventListener('change', () => renderResults(1)));
  form.querySelector('[data-reset-search]')?.addEventListener('click', () => {
    form.querySelector('input[name="q"]').value = '';
    form.querySelector('select[name="type"]').value = '';
    form.querySelector('select[name="points"]').value = '';
    form.querySelector('select[name="state"]').value = '';
    renderResults(1);
    form.querySelector('input[name="q"]')?.focus();
  });
  pager.addEventListener('click', event => {
    const button = event.target.closest('[data-browser-page]');
    if (!button) return;
    renderResults(currentPage + (button.dataset.browserPage === 'next' ? 1 : -1));
    window.scrollTo({top: form.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth'});
  });
  renderResults(initialPage);
}

function questionDetail(id) {
  if (!workspace) return noBankScreen();
  const question = workspace.questions.find(item => item.id === id);
  if (!question) return notFound();
  const card = workspace.cards?.[question.id];
  shell(`<section class="hero"><div><div class="eyebrow">Fragenbrowser</div><h1>Frage</h1></div><div class="hero-actions"><a class="button secondary" href="#/questions">← Zur Suche</a><a class="button" href="#/learn/${encodeURIComponent(question.id)}">Im Lernmodus öffnen</a></div></section><section class="question-detail-grid"><article class="card"><div class="browser-item-meta"><span class="chip">${escapeHtml(typeLabel(question.type))}</span><span class="chip">${escapeHtml(pointsLabel(question.points))}</span><span class="chip">${escapeHtml(stateLabel(card?.state || 'new'))}</span>${card?.dueAt ? `<span class="chip">fällig ${escapeHtml(formatDue(card.dueAt))}</span>` : ''}</div><div class="browser-detail-prompt">${escapeHtml(displayPromptText(question) || '(Frage ohne Text)')}</div>${renderQuestionAssets(question)}${question.instruction?`<div class="note instruction-note">${escapeHtml(question.instruction)}</div>`:''}</article><aside class="card browser-detail-solution-card"><h2>Korrekte Lösung</h2><div id="detail-correct-solution" class="browser-solution-content">${renderCorrectSolution(question)}</div></aside></section><section class="card question-progress-card"><h2>Lernstand und Fälligkeit</h2>${renderQuestionProgressControls(question)}</section>`);
  wireQuestionInteractions(document.getElementById('detail-correct-solution'));
  wireQuestionProgressControls(document.querySelector('.question-progress-card'), () => questionDetail(id));
}

function settingsPage() {
  if (!workspace) return noBankScreen();
  const scheduler = normalizeSchedulerSettings(workspace.settings?.scheduler);
  shell(`<section class="hero"><div><div class="eyebrow">Konfiguration und lokale Daten</div><h1>Einstellungen & Backup</h1><p class="lead">Passe FSRS, kurze Lernschritte und die lokal gespeicherten Fragensammlungen und Lernstände an.</p></div></section>
  <section class="card backup-reminder backup-warning"><div><h2>Wichtig: Dein Lernfortschritt ist nicht automatisch gesichert</h2><p>Der Lernclient speichert ausschließlich in der lokalen Browser-Datenbank. Es gibt kein Nutzerkonto, keine Cloud-Synchronisierung und keine automatische Backup-Datei.</p><ul class="backup-risks"><li>Gelöschte Browserdaten können den gesamten Lernstand entfernen.</li><li>Auf einem anderen Gerät oder in einem anderen Browser ist der Lernstand nicht automatisch vorhanden.</li><li><strong>Lade deshalb nach jeder Lernsitzung selbst ein aktuelles <code>.lernbackup</code> herunter.</strong></li></ul></div><button class="button" data-download-backup>Backup jetzt herunterladen</button></section>
  <section class="grid two-column"><div class="card"><h2>Aktive Sammlung</h2><p><strong>${escapeHtml(workspace.bank.name)}</strong><br><span class="note">${workspace.questions.length} Fragen · ID ${escapeHtml(workspace.bank.id)}</span></p><div class="actions"><div class="action-row"><div class="action-copy"><h3>Fragensammlung aktualisieren</h3><p>Neue <code>.lernbank</code> derselben Bank-ID einlesen; bestehender Fortschritt bleibt für unveränderte Fragen erhalten.</p></div><button class="button secondary" data-open-bank>Öffnen</button></div><div class="action-row"><div class="action-copy"><h3>Persönliches Backup</h3><p>Fragen, Lernstand, Lernhistorie und Wiederholungszeiten in einer Datei sichern.</p></div><button class="button" data-download-backup>Herunterladen</button></div><div class="action-row"><div class="action-copy"><h3>Backup wiederherstellen</h3><p>Ein persönliches <code>.lernbackup</code> übernehmen und mit dem darin gespeicherten Lernstand weiterlernen.</p></div><button class="button secondary" data-open-backup>Öffnen</button></div></div></div><div class="card"><h2>Lokale Sammlungen</h2><div id="workspace-list"><span class="note">Wird geladen …</span></div></div></section>
  <section class="card scheduler-settings-card"><h2>FSRS-Wiederholungsplanung</h2><p>FSRS berechnet für jede Karte Schwierigkeit, Gedächtnisstabilität und den nächsten sinnvollen Wiederholungstermin. Verwendet wird ${escapeHtml(SCHEDULER_NAME)}.</p><p class="note">Diese Einstellungen gelten für zukünftige Bewertungen. Bereits geplante Wiederholungen werden nicht rückwirkend verschoben.</p><form id="scheduler-settings" class="scheduler-settings-form"><div class="scheduler-settings-grid">
    <div class="filter-field"><label for="request-retention-percent">Gewünschte Erinnerungsquote</label><input id="request-retention-percent" name="requestRetentionPercent" type="number" min="70" max="97" step="1" required value="${scheduler.requestRetentionPercent}"><span class="note">Prozent · höher bedeutet mehr Wiederholungen</span></div>
    <div class="filter-field"><label for="learning-steps">Lernschritte für neue Karten</label><input id="learning-steps" name="learningSteps" type="text" required value="${escapeHtml(scheduler.learningSteps)}" placeholder="1m, 10m"><span class="note"><code>m</code> Minuten, <code>h</code> Stunden, <code>d</code> Tage · z. B. <code>1m, 10m</code></span></div>
    <div class="filter-field"><label for="relearning-steps">Wiederlernschritte nach Vergessen</label><input id="relearning-steps" name="relearningSteps" type="text" required value="${escapeHtml(scheduler.relearningSteps)}" placeholder="10m"><span class="note">Kurze Schritte, bevor FSRS wieder dynamisch plant</span></div>
    <div class="filter-field"><label for="maximum-interval-days">Maximales Intervall</label><input id="maximum-interval-days" name="maximumIntervalDays" type="number" min="30" max="36500" step="1" required value="${scheduler.maximumIntervalDays}"><span class="note">Tage · Obergrenze für sehr stabile Karten</span></div>
    <div class="filter-field"><label for="learn-ahead-minutes">Am Sitzungsende vorziehen</label><input id="learn-ahead-minutes" name="learnAheadMinutes" type="number" min="0" max="120" step="1" required value="${scheduler.learnAheadMinutes}"><span class="note">Minuten · Lernkarten in diesem Fenster dürfen vorzeitig erscheinen</span></div>
    <label class="filter-field checkbox-field" for="enable-fuzz"><span>Zeitliche Streuung</span><span><input id="enable-fuzz" name="enableFuzz" type="checkbox" ${scheduler.enableFuzz ? 'checked' : ''}> Lange Intervalle leicht streuen</span><span class="note">Verhindert, dass viele Karten dauerhaft am selben Tag zusammenfallen.</span></label>
  </div><div class="button-row scheduler-settings-actions"><button class="button" type="submit">FSRS-Einstellungen speichern</button><button class="button secondary" type="button" data-reset-scheduler>Standardwerte</button></div></form></section>
  <section class="card danger-zone"><div><h2>Gesamten Lernfortschritt zurücksetzen</h2><p class="note">Löscht alle Termine, Scheduler-Zustände und Bewertungen dieser Sammlung. Fragen, Wiederholungszeit-Einstellungen und heruntergeladene Backups bleiben erhalten.</p></div><button class="button danger" type="button" data-reset-all-progress>Gesamten Lernfortschritt löschen</button></section>`);
  wireFileButtons();
  wireSchedulerSettings();
  wireResetAllProgress();
  renderWorkspaceList();
}

function wireSchedulerSettings() {
  const form = document.getElementById('scheduler-settings');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const scheduler = {
      requestRetentionPercent: Number(data.get('requestRetentionPercent')),
      maximumIntervalDays: Number(data.get('maximumIntervalDays')),
      learningSteps: String(data.get('learningSteps') || ''),
      relearningSteps: String(data.get('relearningSteps') || ''),
      enableFuzz: data.get('enableFuzz') === 'on',
      learnAheadMinutes: Number(data.get('learnAheadMinutes')),
    };
    if (!isValidStepList(scheduler.learningSteps) || !isValidStepList(scheduler.relearningSteps)) {
      setFlash('Lernschritte müssen aufsteigend als Zeitwerte wie „1m, 10m, 1d“ angegeben werden.', 'error');
      return settingsPage();
    }
    workspace.settings = {...(workspace.settings || {}), scheduler: normalizeSchedulerSettings(scheduler)};
    await saveWorkspace(workspace);
    setFlash('FSRS-Einstellungen gespeichert.');
    settingsPage();
  });
  document.querySelector('[data-reset-scheduler]')?.addEventListener('click', async () => {
    workspace.settings = {...(workspace.settings || {}), scheduler: {...DEFAULT_SCHEDULER_SETTINGS}};
    await saveWorkspace(workspace);
    setFlash('Standardwerte wiederhergestellt.');
    settingsPage();
  });
}

function wireResetAllProgress() {
  document.querySelector('[data-reset-all-progress]')?.addEventListener('click', async () => {
    if (!confirm(`Gesamten Lernfortschritt für „${workspace.bank.name}“ wirklich löschen? Alle Fälligkeiten und Bewertungen werden entfernt. Diese Aktion kann nur mit einem zuvor heruntergeladenen Backup rückgängig gemacht werden.`)) return;
    workspace.cards = {};
    workspace.reviews = [];
    await saveWorkspace(workspace);
    checkedQuestion = null;
    setFlash('Gesamter Lernfortschritt zurückgesetzt.');
    settingsPage();
  });
}

async function renderWorkspaceList() {
  const rows = await listWorkspaces();
  const target = document.getElementById('workspace-list'); if (!target) return;
  target.innerHTML = rows.map(item => `<div class="workspace-row"><div><strong>${escapeHtml(item.bank?.name || item.id)}</strong><div class="note">${item.questions?.length || 0} Fragen${item.id===workspace?.id?' · aktiv':''}</div></div><div class="row-actions">${item.id!==workspace?.id?`<button class="button secondary small" data-switch-bank="${escapeHtml(item.id)}">Öffnen</button>`:''}<button class="button danger small" data-delete-bank="${escapeHtml(item.id)}">Löschen</button></div></div>`).join('') || '<p class="note">Keine lokalen Sammlungen.</p>';
  target.querySelectorAll('[data-switch-bank]').forEach(button => button.addEventListener('click', async () => { await setActiveBankId(button.dataset.switchBank); workspace = await getActiveWorkspace(); checkedQuestion=null; setFlash('Sammlung gewechselt.'); location.hash='#/'; route(); }));
  target.querySelectorAll('[data-delete-bank]').forEach(button => button.addEventListener('click', async () => {
    const id = button.dataset.deleteBank; const row=rows.find(item=>item.id===id); if (!confirm(`Lokale Sammlung „${row?.bank?.name || id}“ inklusive Lernfortschritt löschen?`)) return;
    await deleteWorkspace(id); if (workspace?.id===id) workspace=await getActiveWorkspace(); setFlash('Lokale Sammlung gelöscht.'); route();
  }));
}

function wireFileButtons() {
  document.querySelectorAll('[data-open-bank]').forEach(button => button.addEventListener('click', () => bankInput.click()));
  document.querySelectorAll('[data-open-backup]').forEach(button => button.addEventListener('click', () => backupInput.click()));
  document.querySelectorAll('[data-download-backup]').forEach(button => button.addEventListener('click', () => downloadBackup(workspace)));
}

bankInput.addEventListener('change', async () => {
  try {
    const payload = await readLearningFile(bankInput.files?.[0]);
    if (payload.format !== BANK_FORMAT) throw new Error('Bitte hier eine .lernbank-Fragensammlung auswählen.');
    const result = await importBankPayload(payload); workspace = result.workspace; checkedQuestion=null;
    setFlash(result.updated ? `Fragensammlung aktualisiert. ${result.preservedCards} Lernstände wurden übernommen.` : `${workspace.bank.name} wurde lokal gespeichert.`);
    location.hash='#/'; route();
  } catch (error) { setFlash(error.message, 'error'); route(); }
  finally { bankInput.value=''; }
});

backupInput.addEventListener('change', async () => {
  try {
    const payload = await readLearningFile(backupInput.files?.[0]);
    if (payload.format !== BACKUP_FORMAT) throw new Error('Bitte hier eine .lernbackup-Datei auswählen.');
    workspace = await importBackupPayload(payload); checkedQuestion=null; setFlash(`Backup für ${workspace.bank.name} wiederhergestellt.`); location.hash='#/'; route();
  } catch (error) { setFlash(error.message, 'error'); route(); }
  finally { backupInput.value=''; }
});

function notFound() { shell('<div class="card empty"><div class="empty-mark">404</div><h2>Seite nicht gefunden</h2><a class="button secondary" href="#/">Zur Übersicht</a></div>'); }

async function route() {
  workspace = workspace || await getActiveWorkspace();
  setAssetStore(workspace?.assets || {});
  const hash = location.hash || '#/';
  const path = hash.slice(1).split('?')[0] || '/';
  if (path !== '/learn/session' && !path.startsWith('/learn/')) {
    learningSessionSeed = null;
    activeQuestionPresentation = null;
  }
  if (path === '/') return dashboard();
  if (path === '/learn') return learnHome();
  if (path === '/learn/session') return learningQuestion();
  if (path.startsWith('/learn/')) return learningQuestion(decodeURIComponent(path.slice('/learn/'.length)));
  if (path === '/questions') return questionsBrowser();
  if (path.startsWith('/question/')) return questionDetail(decodeURIComponent(path.slice('/question/'.length)));
  if (path === '/settings' || path === '/data') return settingsPage();
  return notFound();
}

window.addEventListener('hashchange', () => { checkedQuestion = null; activeQuestionPresentation = null; route(); });
window.addEventListener('DOMContentLoaded', route);
