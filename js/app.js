import {
  getActiveWorkspace, importBankPayload, importBackupPayload, saveWorkspace,
  listWorkspaces, setActiveBankId, deleteWorkspace,
} from './storage.js';
import {BANK_FORMAT, BACKUP_FORMAT, readLearningFile, downloadBackup} from './formats.js';
import {learningStats, nextQuestion, scheduleReview, ratingLabel} from './scheduler.js';
import {
  renderInteraction, collectResponse, evaluateAnswer, renderFeedback,
  wireQuestionInteractions, solutionLines, searchableText,
} from './questions.js';

const app = document.getElementById('app');
const nav = document.getElementById('main-nav');
const bankInput = document.getElementById('bank-file-input');
const backupInput = document.getElementById('backup-file-input');
let workspace = null;
let checkedQuestion = null;
let flash = null;

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function pointsLabel(points) {
  if (points === null || points === undefined) return 'Ohne Punktzahl';
  return `${points} ${Number(points) === 1 ? 'Punkt' : 'Punkte'}`;
}

function typeLabel(type) {
  return ({single_choice:'Single Choice', multiple_choice:'Multiple Choice', choice_matrix:'Matrix', cloze:'Lückentext', matching:'Zuordnung', ordering:'Reihenfolge'})[type] || type;
}

function stateLabel(state) {
  return ({new:'Neu', learning:'Lernen', review:'Wiederholung', relearning:'Wiederlernen'})[state] || state;
}

function renderQuestionAssets(question) {
  const assets = (question?.assets || []).filter(asset => typeof asset?.url === 'string' && /^(https:\/\/|data:image\/)/i.test(asset.url));
  if (!assets.length) return '';
  return `<div class="question-assets">${assets.map(asset => `<img class="question-asset" src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.alt || '')}" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`;
}

function formatDue(value) {
  if (!value) return '–';
  const date = new Date(value);
  return new Intl.DateTimeFormat('de-DE', {dateStyle:'medium', timeStyle:'short'}).format(date);
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
    ['#/', 'Übersicht', 'home'], ['#/learn', 'Lernen', 'learn'], ['#/questions', 'Fragen', 'questions'], ['#/data', 'Daten', 'data'],
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
    <button class="import-card" data-open-backup><span class="import-icon">↥</span><strong>Backup wiederherstellen</strong><span>.lernbackup importieren</span></button>
  </section>
  <section class="card privacy-card"><h2>Lokale Verarbeitung</h2><p>Fragen und Lernfortschritt werden in IndexedDB auf diesem Gerät gespeichert. Der Lernclient besitzt kein Nutzerkonto und überträgt die importierten Dateien nicht an einen Lernserver.</p></section>`);
  wireFileButtons();
}

function dashboard() {
  if (!workspace) return noBankScreen();
  const stats = learningStats(workspace);
  const accuracy = stats.accuracy === null ? '–' : `${Math.round(stats.accuracy)} %`;
  shell(`<section class="hero"><div><div class="eyebrow">${escapeHtml(workspace.bank.name)}</div><h1>Weiterlernen.</h1><p class="lead">Revision ${escapeHtml(String(workspace.bank.revision || '').slice(0,12) || '–')} · ${workspace.questions.length} Fragen lokal geladen.</p></div><div class="hero-actions"><a class="button" href="#/learn/session">Lernsitzung starten</a></div></section>
  <section class="grid metrics"><div class="card metric warning"><div class="metric-value">${stats.due}</div><div class="metric-label">jetzt fällig</div></div><div class="card metric"><div class="metric-value">${stats.new}</div><div class="metric-label">noch neu</div></div><div class="card metric good"><div class="metric-value">${stats.review}</div><div class="metric-label">im Wiederholungsmodus</div></div><div class="card metric"><div class="metric-value">${accuracy}</div><div class="metric-label">Antwortgenauigkeit</div></div></section>
  <section class="grid two-column"><div class="card"><h2>Lernstand</h2><p><strong>${stats.learning}</strong> in der Lernphase · <strong>${stats.relearning}</strong> im Wiederlernen · <strong>${stats.reviews}</strong> Bewertungen gespeichert.</p><p class="note">Fällige Wiederholungen werden vor neuen Fragen abgearbeitet.</p></div><div class="card"><h2>Dateien</h2><p class="note">Eine neue <code>.lernbank</code> derselben Sammlung aktualisiert die Fragen und übernimmt den vorhandenen Fortschritt anhand der stabilen Fragen-IDs.</p><div class="button-row"><button class="button secondary" data-open-bank>Sammlung aktualisieren</button><button class="button secondary" data-download-backup>Backup</button></div></div></section>`);
  wireFileButtons();
  document.querySelector('[data-download-backup]')?.addEventListener('click', () => downloadBackup(workspace));
}

function learnHome() {
  if (!workspace) return noBankScreen();
  const stats = learningStats(workspace);
  const next = nextQuestion(workspace);
  shell(`<section class="hero"><div><div class="eyebrow">Spaced Repetition</div><h1>Lernen</h1><p class="lead">Beantworte die Aufgabe wie im Online-Test, prüfe sie und bewerte anschließend, wie gut du sie erinnern konntest.</p></div><div class="hero-actions">${next ? '<a class="button" href="#/learn/session">Lernsitzung starten</a>' : ''}</div></section>
  <section class="grid metrics"><div class="card metric warning"><div class="metric-value">${stats.due}</div><div class="metric-label">jetzt fällig</div></div><div class="card metric"><div class="metric-value">${stats.new}</div><div class="metric-label">noch neu</div></div><div class="card metric good"><div class="metric-value">${stats.review}</div><div class="metric-label">Wiederholungsmodus</div></div><div class="card metric"><div class="metric-value">${stats.reviews}</div><div class="metric-label">Bewertungen</div></div></section>
  ${next ? '' : '<div class="card empty"><div class="empty-mark">✓</div><h2>Aktuell nichts zu lernen</h2><p class="note">Es gibt weder fällige Wiederholungen noch neue Fragen.</p></div>'}`);
}

function learningQuestion(requestedId = null) {
  if (!workspace) return noBankScreen();
  const question = nextQuestion(workspace, requestedId);
  if (!question) return learnHome();
  const card = workspace.cards?.[question.id];
  const checked = checkedQuestion?.id === question.id ? checkedQuestion : null;
  const response = checked?.response || {};
  const result = checked?.result || null;
  const status = card?.state || 'new';
  shell(`<section class="learning-shell">
    <div class="learning-topline"><div class="question-meta"><span class="question-meta-strong">Aufgabe · ${escapeHtml(pointsLabel(question.points))}</span><span class="chip">${escapeHtml(typeLabel(question.type))}</span><span class="chip">${escapeHtml(stateLabel(status))}</span>${card?.dueAt ? `<span class="chip">fällig ${escapeHtml(formatDue(card.dueAt))}</span>` : ''}</div><a href="#/learn" class="quiet-link">Sitzung verlassen</a></div>
    <article class="card learning-card"><div class="question-instruction">${escapeHtml(question.instruction || '')}</div><div class="question-prompt">${escapeHtml(question.prompt?.text || '(Frage ohne Text)')}</div>${renderQuestionAssets(question)}
      <div id="question-interaction">${renderInteraction(question, response, result)}</div>${renderFeedback(question, result)}
      ${result ? renderRatings(question, result) : '<div class="learning-actions"><button id="check-answer" class="button" type="button">Antwort prüfen</button></div>'}
    </article></section>`);
  const interaction = document.getElementById('question-interaction');
  wireQuestionInteractions(interaction);
  if (!result) {
    document.getElementById('check-answer')?.addEventListener('click', () => {
      const responseNow = collectResponse(interaction, question);
      checkedQuestion = {id: question.id, response: responseNow, result: evaluateAnswer(question, responseNow)};
      learningQuestion(question.id);
    });
  } else {
    document.querySelectorAll('[data-rating]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      const rating = button.dataset.rating;
      const scheduled = await scheduleReview(question.id, workspace.cards?.[question.id], rating, result.correct);
      workspace.cards = {...(workspace.cards || {}), [question.id]: scheduled.card};
      workspace.reviews = [...(workspace.reviews || []), scheduled.review];
      await saveWorkspace(workspace);
      setFlash(`${ratingLabel(rating)} gespeichert. Nächster Termin: ${formatDue(scheduled.card.dueAt)}.`);
      checkedQuestion = null;
      learningQuestion();
    }));
  }
}

function renderRatings(question, result) {
  return `<div class="rating-panel"><div><strong>Wie gut konntest du dich erinnern?</strong><div class="note">Die fachliche Auswertung (${result.earned}/${result.total || 1}) wird getrennt von deiner Erinnerungsbewertung gespeichert.</div></div><div class="rating-grid">
    <button type="button" class="rating forgot" data-rating="forgot"><strong>Vergessen</strong><span>zurück in die Lernphase</span></button>
    <button type="button" class="rating partial" data-rating="partial"><strong>Teilweise</strong><span>kurzes Intervall</span></button>
    <button type="button" class="rating effort" data-rating="effort"><strong>Mit Anstrengung</strong><span>normales Intervall</span></button>
    <button type="button" class="rating easy" data-rating="easy"><strong>Leicht</strong><span>größeres Intervall</span></button>
  </div></div>`;
}

function questionsBrowser() {
  if (!workspace) return noBankScreen();
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const q = params.get('q') || '';
  const type = params.get('type') || '';
  const points = params.get('points') || '';
  const page = Math.max(1, Number(params.get('page') || 1) || 1);
  const pageSize = 40;
  const terms = q.trim().toLocaleLowerCase('de').split(/\s+/).filter(Boolean);
  const items = workspace.questions.filter(question => {
    if (type && question.type !== type) return false;
    if (points && (points === 'none' ? question.points !== null && question.points !== undefined : String(question.points) !== points)) return false;
    const text = searchableText(question);
    return terms.every(term => text.includes(term.normalize('NFKC').toLocaleLowerCase('de')));
  });
  const startIndex = (page - 1) * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  const types = [...new Set(workspace.questions.map(question => question.type))].sort();
  const pointValues = [...new Set(workspace.questions.map(question => question.points).filter(value => value !== null && value !== undefined))].sort((a,b)=>a-b);
  const rows = pageItems.map(question => {
    const lines = solutionLines(question);
    return `<article class="browser-item"><div class="browser-item-head"><div><h3 class="browser-item-title">${escapeHtml(question.prompt?.text || '(Frage ohne Text)')}</h3><div class="browser-item-meta"><span class="chip">${escapeHtml(typeLabel(question.type))}</span><span class="chip">${escapeHtml(pointsLabel(question.points))}</span>${workspace.cards?.[question.id] ? `<span class="chip">${escapeHtml(stateLabel(workspace.cards[question.id].state))}</span>` : ''}</div></div><a class="button secondary small" href="#/question/${encodeURIComponent(question.id)}">Öffnen</a></div><div class="browser-solution"><strong>Lösung</strong><ul class="browser-solution-lines">${lines.slice(0,3).map(line=>`<li>${escapeHtml(line)}</li>`).join('')}${lines.length>3?`<li class="note">… ${lines.length-3} weitere Zeile(n)</li>`:''}</ul></div></article>`;
  }).join('') || '<div class="card empty"><div class="empty-mark">?</div><h2>Keine Treffer</h2><p class="note">Passe Suche oder Filter an.</p></div>';
  const end = Math.min(startIndex + pageItems.length, items.length);
  shell(`<section class="hero"><div><div class="eyebrow">Nachschlagen</div><h1>Fragenbrowser</h1><p class="lead">Durchsuche Fragen, Aufgabenstellungen und sämtliche Lösungstexte deiner lokal geladenen Fragensammlung.</p></div></section>
  <section class="card"><form id="question-search" class="question-browser-form"><div class="filter-field search-wide"><label for="q">Freie Suche</label><input id="q" type="search" name="q" value="${escapeHtml(q)}" placeholder="Frage oder Lösung durchsuchen …"></div><div class="filter-field"><label for="type">Fragentyp</label><select id="type" name="type"><option value="">Alle Typen</option>${types.map(value=>`<option value="${escapeHtml(value)}" ${value===type?'selected':''}>${escapeHtml(typeLabel(value))}</option>`).join('')}</select></div><div class="filter-field"><label for="points">Punktzahl</label><select id="points" name="points"><option value="">Alle Punktzahlen</option>${pointValues.map(value=>`<option value="${value}" ${String(value)===points?'selected':''}>${escapeHtml(pointsLabel(value))}</option>`).join('')}<option value="none" ${points==='none'?'selected':''}>Ohne Punktzahl</option></select></div><button class="button" type="submit">Suchen</button></form></section>
  <div class="browser-summary"><span>${items.length} Treffer · angezeigt ${items.length ? startIndex+1 : 0}–${end}</span><a href="#/questions">Filter zurücksetzen</a></div><section class="browser-list">${rows}</section><div class="browser-pager">${page>1?`<a class="button secondary small" href="${browserPageHref(q,type,points,page-1)}">← Zurück</a>`:'<span></span>'}${end<items.length?`<a class="button secondary small" href="${browserPageHref(q,type,points,page+1)}">Weiter →</a>`:'<span></span>'}</div>`);
  document.getElementById('question-search')?.addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const next = new URLSearchParams();
    for (const key of ['q','type','points']) if (data.get(key)) next.set(key, data.get(key));
    location.hash = '#/questions' + (next.toString() ? `?${next}` : '');
  });
}

function browserPageHref(q,type,points,page) {
  const params = new URLSearchParams(); if(q)params.set('q',q); if(type)params.set('type',type); if(points)params.set('points',points); if(page>1)params.set('page',String(page));
  return '#/questions' + (params.toString()?`?${params}`:'');
}

function questionDetail(id) {
  if (!workspace) return noBankScreen();
  const question = workspace.questions.find(item => item.id === id);
  if (!question) return notFound();
  const card = workspace.cards?.[question.id];
  shell(`<section class="hero"><div><div class="eyebrow">Fragenbrowser</div><h1>Frage</h1></div><div class="hero-actions"><a class="button secondary" href="#/questions">← Zur Suche</a><a class="button" href="#/learn/${encodeURIComponent(question.id)}">Im Lernmodus öffnen</a></div></section><section class="grid two-column"><article class="card"><div class="browser-item-meta"><span class="chip">${escapeHtml(typeLabel(question.type))}</span><span class="chip">${escapeHtml(pointsLabel(question.points))}</span>${card?`<span class="chip">${escapeHtml(stateLabel(card.state))}</span>`:''}</div><div class="browser-detail-prompt">${escapeHtml(question.prompt?.text || '(Frage ohne Text)')}</div>${renderQuestionAssets(question)}${question.instruction?`<div class="note instruction-note">${escapeHtml(question.instruction)}</div>`:''}</article><aside class="card"><h2>Korrekte Lösung</h2><div class="browser-detail-solutions">${solutionLines(question).map(line=>`<div class="browser-detail-solution">${escapeHtml(line)}</div>`).join('')}</div></aside></section>`);
}

function dataPage() {
  if (!workspace) return noBankScreen();
  shell(`<section class="hero"><div><div class="eyebrow">Lokale Daten</div><h1>Daten & Backup</h1><p class="lead">Fragensammlungen und Lernfortschritt liegen ausschließlich in der Browser-Datenbank dieses Geräts.</p></div></section>
  <section class="grid two-column"><div class="card"><h2>Aktive Sammlung</h2><p><strong>${escapeHtml(workspace.bank.name)}</strong><br><span class="note">${workspace.questions.length} Fragen · ID ${escapeHtml(workspace.bank.id)}</span></p><div class="actions"><div class="action-row"><div class="action-copy"><h3>Fragensammlung aktualisieren</h3><p>Neue <code>.lernbank</code> derselben Bank-ID einlesen; bestehender Fortschritt bleibt für unveränderte Fragen erhalten.</p></div><button class="button secondary" data-open-bank>Öffnen</button></div><div class="action-row"><div class="action-copy"><h3>Persönliches Backup</h3><p>Fragen, Scheduler-Zustand und Lernhistorie in einer Datei sichern.</p></div><button class="button" data-download-backup>Herunterladen</button></div><div class="action-row"><div class="action-copy"><h3>Backup wiederherstellen</h3><p>Eine <code>.lernbackup</code> vollständig in den Browser übernehmen.</p></div><button class="button secondary" data-open-backup>Öffnen</button></div></div></div><div class="card"><h2>Lokale Sammlungen</h2><div id="workspace-list"><span class="note">Wird geladen …</span></div></div></section>`);
  wireFileButtons();
  document.querySelector('[data-download-backup]')?.addEventListener('click', () => downloadBackup(workspace));
  renderWorkspaceList();
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
  const hash = location.hash || '#/';
  const path = hash.slice(1).split('?')[0] || '/';
  if (path === '/') return dashboard();
  if (path === '/learn') return learnHome();
  if (path === '/learn/session') return learningQuestion();
  if (path.startsWith('/learn/')) return learningQuestion(decodeURIComponent(path.slice('/learn/'.length)));
  if (path === '/questions') return questionsBrowser();
  if (path.startsWith('/question/')) return questionDetail(decodeURIComponent(path.slice('/question/'.length)));
  if (path === '/data') return dataPage();
  return notFound();
}

window.addEventListener('hashchange', () => { checkedQuestion = null; route(); });
window.addEventListener('DOMContentLoaded', route);
