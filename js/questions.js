function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

let assetStore = {};

export function setAssetStore(assets) {
  assetStore = assets && typeof assets === 'object' && !Array.isArray(assets) ? assets : {};
}

export function resolveAsset(assetOrId) {
  const reference = typeof assetOrId === 'string' ? {id: assetOrId} : (assetOrId || {});
  const id = reference.id || (reference.sha256 ? `asset_${reference.sha256}` : '');
  const embedded = assetStore[id];
  if (embedded?.kind === 'image' && typeof embedded.mimeType === 'string' && embedded.mimeType.startsWith('image/') && typeof embedded.dataBase64 === 'string') {
    return `data:${embedded.mimeType};base64,${embedded.dataBase64}`;
  }
  const legacy = reference.url || '';
  return /^(data:image\/|https:\/\/)/i.test(legacy) ? legacy : '';
}

export function renderAssetsForRoles(question, roles) {
  const images = (question?.assets || []).filter(asset => {
    const role = asset?.role === 'question' ? 'prompt' : (asset?.role || 'prompt');
    return !roles || roles.has(role);
  }).map(asset => {
    const source = resolveAsset(asset);
    if (!source) return `<div class="asset-warning">⚠ Dieses Bild ist in der Lernbank nicht verfügbar.</div>`;
    return `<img class="question-asset" src="${escapeHtml(source)}" alt="${escapeHtml(asset.alt || '')}" loading="lazy">`;
  });
  return images.length ? `<div class="question-assets">${images.join('')}</div>` : '';
}

const PROMPT_BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TR', 'UL',
]);

function structuredTextFromHtml(html) {
  if (!html || typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = String(html);
  let output = '';
  const newline = () => {
    if (output && !output.endsWith('\n')) output += '\n';
  };
  const visit = node => {
    if (node.nodeType === 3) {
      output += node.nodeValue || '';
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'BR') {
      newline();
      return;
    }
    const isBlock = PROMPT_BLOCK_ELEMENTS.has(node.tagName);
    if (isBlock) newline();
    node.childNodes.forEach(visit);
    if (isBlock) newline();
  };
  template.content.childNodes.forEach(visit);
  return output
    .replaceAll('\u00a0', ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function contentWithoutWhitespace(value) {
  return String(value ?? '').replace(/\s+/gu, '');
}

export function displayPromptText(question) {
  const text = String(question?.prompt?.text || '');
  const structured = structuredTextFromHtml(question?.prompt?.html);
  if (structured.includes('\n') && contentWithoutWhitespace(structured) === contentWithoutWhitespace(text)) {
    return structured;
  }
  return text;
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').toLocaleLowerCase('de').trim().replace(/\s+/g, ' ');
}

function responseOne(response, key) {
  const value = response?.[key];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function responseMany(response, key) {
  const value = response?.[key];
  if (Array.isArray(value)) return value.map(String);
  return value === undefined || value === null || value === '' ? [] : [String(value)];
}

function resultClass(ok, selected = true) {
  if (!selected) return '';
  return ok ? 'is-correct' : 'is-wrong';
}

export function evaluateAnswer(question, response) {
  const answer = question.answer || {};
  const details = [];
  if (['single_choice', 'multiple_choice'].includes(question.type)) {
    const options = answer.options || [];
    const selected = new Set(responseMany(response, 'choice').filter(item => /^\d+$/.test(item)).map(Number));
    const expected = new Set(options.map((option, index) => option.correct ? index : null).filter(index => index !== null));
    options.forEach((option, index) => details.push({label: option.text || '', selected: selected.has(index), correct: expected.has(index)}));
    const correct = selected.size === expected.size && [...selected].every(index => expected.has(index));
    return {correct, details, earned: Number(correct), total: 1};
  }
  if (question.type === 'choice_matrix') {
    const groups = answer.groups || [];
    let correctCount = 0;
    groups.forEach((group, index) => {
      const raw = responseOne(response, `group_${index}`);
      const selected = /^\d+$/.test(raw) ? Number(raw) : null;
      const expected = (group.options || []).findIndex(option => option.correct);
      const ok = selected === expected;
      correctCount += Number(ok);
      details.push({label: group.prompt || `Teilfrage ${index + 1}`, correct: ok, selected, expected});
    });
    return {correct: correctCount === groups.length, details, earned: correctCount, total: groups.length};
  }
  if (question.type === 'cloze') {
    const gaps = (answer.segments || []).filter(segment => segment.kind === 'gap');
    let correctCount = 0;
    gaps.forEach((gap, index) => {
      const supplied = responseOne(response, `gap_${index}`);
      const expected = new Set((gap.answers || []).map(normalizeText));
      const ok = expected.has(normalizeText(supplied));
      correctCount += Number(ok);
      details.push({label: supplied, correct: ok, expected: (gap.answers || []).join(' / ')});
    });
    return {correct: correctCount === gaps.length, details, earned: correctCount, total: gaps.length};
  }
  if (question.type === 'matching') {
    const left = answer.left || [];
    let correctCount = 0;
    if (answer.interaction === 'lines') {
      left.forEach((leftItem, index) => {
        const expectedLabels = (answer.pairs || [])
          .filter(pair => normalizeText(pair.left) === normalizeText(leftItem))
          .map(pair => String(pair.right || ''));
        const suppliedLabels = responseMany(response, `match_${index}`).filter(Boolean);
        const expected = new Set(expectedLabels.map(normalizeText));
        const supplied = new Set(suppliedLabels.map(normalizeText));
        const ok = supplied.size === expected.size && [...supplied].every(value => expected.has(value));
        correctCount += Number(ok);
        details.push({label: leftItem, correct: ok, expected: expectedLabels, supplied: suppliedLabels});
      });
    } else {
      const expectedPairs = new Map((answer.pairs || []).map(pair => [normalizeText(pair.left), normalizeText(pair.right)]));
      left.forEach((leftItem, index) => {
        const supplied = responseOne(response, `match_${index}`);
        const expectedNormalized = expectedPairs.get(normalizeText(leftItem)) || '';
        const expectedLabel = (answer.pairs || []).find(pair => normalizeText(pair.left) === normalizeText(leftItem))?.right || '';
        const ok = normalizeText(supplied) === expectedNormalized;
        correctCount += Number(ok);
        details.push({label: leftItem, correct: ok, expected: expectedLabel, supplied});
      });
    }
    return {correct: correctCount === left.length, details, earned: correctCount, total: left.length};
  }
  if (question.type === 'ordering') {
    const items = answer.items || [];
    const supplied = responseOne(response, 'order').split(',').filter(item => /^\d+$/.test(item.trim())).map(Number);
    const expected = items.map((_, index) => index);
    const correctCount = supplied.reduce((sum, item, index) => sum + Number(item === expected[index]), 0);
    return {
      correct: supplied.length === expected.length && supplied.every((item, index) => item === expected[index]),
      details: supplied.map((item, index) => ({label: items[item] || '', correct: item === expected[index], expected: items[index] || ''})),
      earned: correctCount, total: items.length,
    };
  }
  if (question.type === 'image_drag_drop') {
    let supplied = {};
    try { supplied = JSON.parse(responseOne(response, 'image_placements') || '{}'); } catch { supplied = {}; }
    const items = new Map((answer.items || []).map(item => [String(item.id), String(item.text || '')]));
    const expected = new Map((answer.placements || []).map(item => [String(item.targetId), String(item.itemId)]));
    let correctCount = 0;
    (answer.targets || []).forEach(target => {
      const targetId = String(target.id);
      const actual = String(supplied[targetId] || '');
      const wanted = expected.get(targetId) || '';
      const ok = actual === wanted;
      correctCount += Number(ok);
      details.push({targetId, correct: ok, supplied: items.get(actual) || '', expected: items.get(wanted) || ''});
    });
    return {correct: correctCount === (answer.targets || []).length, details, earned: correctCount, total: (answer.targets || []).length};
  }
  return {correct: null, details: [], earned: 0, total: 0};
}

function deterministicInitialOrder(length, seedText) {
  const values = Array.from({length}, (_, index) => index);
  let seed = [...String(seedText)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  for (let index = values.length - 1; index > 0; index--) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const target = seed % (index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

function shuffledIndices(length, presentationSeed, scope) {
  const original = Array.from({length}, (_, index) => index);
  if (!presentationSeed || length < 2) return original;
  const shuffled = deterministicInitialOrder(length, `${presentationSeed}\u0000${scope}`);
  if (shuffled.every((value, index) => value === index)) shuffled.push(shuffled.shift());
  return shuffled;
}

function shuffledValues(values, presentationSeed, scope) {
  return shuffledIndices(values.length, presentationSeed, scope).map(index => values[index]);
}

function renderChoice(question, response, result, presentationSeed) {
  const multiple = question.type === 'multiple_choice';
  const selected = new Set(responseMany(response, 'choice').map(Number));
  const options = question.answer.options || [];
  return `<div class="choice-list">${shuffledIndices(options.length, presentationSeed, 'choice').map(optionIndex => {
    const option = options[optionIndex];
    const isSelected = selected.has(optionIndex);
    let cls = '';
    if (result && (isSelected || option.correct)) cls = option.correct ? 'is-correct' : 'is-wrong';
    return `<label class="choice-option ${cls}">
      <input type="${multiple ? 'checkbox' : 'radio'}" name="choice" value="${optionIndex}" ${isSelected ? 'checked' : ''} ${result ? 'disabled' : ''}>
      <span class="choice-control"></span><span>${escapeHtml(option.text)}</span>
      ${result && option.correct ? '<span class="answer-mark">✓</span>' : result && isSelected ? '<span class="answer-mark">×</span>' : ''}
    </label>`;
  }).join('')}</div>`;
}

function renderMatrix(question, response, result, presentationSeed) {
  return `<div class="matrix-list">${(question.answer.groups || []).map((group, groupIndex) => {
    const selected = responseOne(response, `group_${groupIndex}`);
    const expected = (group.options || []).findIndex(option => option.correct);
    const heading = group.prompt ? `<div class="matrix-prompt">${escapeHtml(group.prompt)}</div>` : '';
    const options = group.options || [];
    return `<section class="matrix-group">${heading}<div class="choice-list compact">${shuffledIndices(options.length, presentationSeed, `matrix:${groupIndex}`).map(optionIndex => {
      const option = options[optionIndex];
      const isSelected = String(optionIndex) === selected;
      const cls = result && (isSelected || option.correct) ? (option.correct ? 'is-correct' : 'is-wrong') : '';
      return `<label class="choice-option ${cls}"><input type="radio" name="group_${groupIndex}" value="${optionIndex}" ${isSelected ? 'checked' : ''} ${result ? 'disabled' : ''}><span class="choice-control"></span><span>${escapeHtml(option.text)}</span>${result && optionIndex === expected ? '<span class="answer-mark">✓</span>' : result && isSelected ? '<span class="answer-mark">×</span>' : ''}</label>`;
    }).join('')}</div></section>`;
  }).join('')}</div>`;
}

function renderCloze(question, response, result, presentationSeed) {
  let gapIndex = 0;
  const segments = (question.answer.segments || []).map(segment => {
    if (segment.kind === 'text') return escapeHtml(segment.text || '');
    if (segment.kind !== 'gap') return '';
    const index = gapIndex++;
    const value = responseOne(response, `gap_${index}`);
    const detail = result?.details?.[index];
    const cls = detail ? resultClass(detail.correct) : '';
    const options = segment.options || [];
    if (segment.inputMode === 'select' && options.length) {
      const presentedOptions = shuffledValues(options, presentationSeed, `cloze:${index}`);
      return `<span class="cloze-wrap ${cls}"><select name="gap_${index}" ${result ? 'disabled' : ''}><option value="">–</option>${presentedOptions.map(option => `<option value="${escapeHtml(option)}" ${value === String(option) ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></span>`;
    }
    return `<span class="cloze-wrap ${cls}"><input type="text" name="gap_${index}" value="${escapeHtml(value)}" autocomplete="off" ${result ? 'disabled' : ''}></span>`;
  }).join('');
  let correctText = '';
  if (result && !result.correct) {
    let i = 0;
    correctText = `<div class="correct-answer"><strong>Richtige Antwort:</strong><div class="cloze-correct-flow">${(question.answer.segments || []).map(segment => segment.kind === 'text' ? escapeHtml(segment.text || '') : `<span>${escapeHtml((segment.answers || []).join(' / ') || '???')}</span>${i++ === -1 ? '' : ''}`).join('')}</div></div>`;
  }
  return `<div class="cloze-flow">${segments}</div>${correctText}`;
}

function renderDragMatch(question, response, result, presentationSeed) {
  const answer = question.answer || {};
  const assigned = new Set((answer.left || []).map((_, index) => responseOne(response, `match_${index}`)).filter(Boolean));
  const leftOrder = shuffledIndices((answer.left || []).length, presentationSeed, 'matching:left');
  const available = shuffledValues(answer.right || [], presentationSeed, 'matching:right').filter(value => !assigned.has(value));
  return `<div class="learning-drag-match" data-checked="${result ? '1' : '0'}">
    <div class="match-grid">${leftOrder.map(index => {
      const left = answer.left[index];
      const value = responseOne(response, `match_${index}`);
      const detail = result?.details?.[index];
      const cls = detail ? (detail.correct ? 'is-correct' : 'is-wrong') : '';
      return `<div class="match-row"><div class="match-left">${escapeHtml(left)}</div><div class="match-arrow">→</div>
        <div class="match-answer ${value ? 'has-value' : ''} ${cls}" data-input-id="match_${index}">${value ? escapeHtml(value) : '<span class="match-empty">?</span>'}</div>
        <input id="match_${index}" type="hidden" name="match_${index}" value="${escapeHtml(value)}">
        ${result && detail && !detail.correct ? `<div class="match-expected">${escapeHtml(detail.expected)}</div>` : ''}
      </div>`;
    }).join('')}</div>
    ${result ? '' : `<div class="match-token-list">${available.map(value => `<button type="button" class="match-token" draggable="true" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')}</div>`}
  </div>`;
}

function renderLineMatch(question, response, result, presentationSeed) {
  const answer = question.answer || {};
  const right = answer.right || [];
  const leftOrder = shuffledIndices((answer.left || []).length, presentationSeed, 'matching:left');
  const rightOrder = shuffledIndices(right.length, presentationSeed, 'matching:right');
  const pairedLeft = new Set((answer.pairs || []).map(pair => normalizeText(pair.left)));
  const pairedRight = new Set((answer.pairs || []).map(pair => normalizeText(pair.right)));
  return `<div class="learning-line-match" data-checked="${result ? '1' : '0'}">
    ${result ? '' : '<p class="interaction-hint">Mehrere Linien pro Karte sind auf beiden Seiten möglich. Wähle für jede Linie zuerst die linke und danach die rechte Karte.</p>'}
    <svg class="line-surface" aria-hidden="true"></svg>
    <div class="line-columns">
      <div class="line-left-column">${leftOrder.map(index => {
        const left = answer.left[index];
        const currentValues = responseMany(response, `match_${index}`).filter(Boolean);
        const currentIndices = currentValues.map(value => right.findIndex(item => normalizeText(item) === normalizeText(value))).filter(value => value >= 0);
        const detail = result?.details?.[index];
        const expectedLabels = Array.isArray(detail?.expected) ? detail.expected : detail?.expected ? [detail.expected] : [];
        const correctIndices = expectedLabels.map(value => right.findIndex(item => normalizeText(item) === normalizeText(value))).filter(value => value >= 0);
        const unmatched = !pairedLeft.has(normalizeText(left));
        return `<button type="button" class="line-node line-left ${result && detail ? (detail.correct ? 'is-correct' : 'is-wrong') : ''} ${result && unmatched ? 'is-unmatched' : ''}" data-left-index="${index}" data-current-indices="${currentIndices.join(',')}" data-correct-indices="${correctIndices.join(',')}" ${result ? 'disabled' : ''}><span>${escapeHtml(left)}</span>${result && unmatched ? '<span class="line-unmatched-label">ohne Zuordnung</span>' : ''}<span class="line-port"></span></button>`;
      }).join('')}</div>
      <div class="line-right-column">${rightOrder.map(index => {
        const value = right[index];
        const unmatched = !pairedRight.has(normalizeText(value));
        return `<button type="button" class="line-node line-right ${result && unmatched ? 'is-unmatched' : ''}" data-right-index="${index}" data-value="${escapeHtml(value)}" ${result ? 'disabled' : ''}><span class="line-port"></span><span>${escapeHtml(value)}</span>${result && unmatched ? '<span class="line-unmatched-label">ohne Zuordnung</span>' : ''}</button>`;
      }).join('')}</div>
    </div>
    ${result ? '' : '<div class="line-tools"><button type="button" class="button secondary small line-clear">Alle Zuordnungen löschen</button></div>'}
  </div>`;
}

function renderMatching(question, response, result, presentationSeed) {
  return question.answer?.interaction === 'lines'
    ? renderLineMatch(question, response, result, presentationSeed)
    : renderDragMatch(question, response, result, presentationSeed);
}

function renderOrdering(question, response, result, presentationSeed) {
  const items = question.answer.items || [];
  let order = responseOne(response, 'order').split(',').filter(value => /^\d+$/.test(value)).map(Number);
  if (!order.length) order = shuffledIndices(items.length, presentationSeed, 'ordering');
  return `<div class="ordering-wrap"><div class="sortable-list" data-checked="${result ? '1' : '0'}">${order.map((itemIndex, position) => {
    const detail = result?.details?.[position];
    const cls = detail ? (detail.correct ? 'is-correct' : 'is-wrong') : '';
    return `<div class="sortable-item ${cls}" draggable="${result ? 'false' : 'true'}" data-item-index="${itemIndex}"><span class="drag-handle">⋮⋮</span><span class="sort-position">${position + 1}</span><span class="sort-text">${escapeHtml(items[itemIndex])}</span>${result && detail && !detail.correct ? `<span class="sort-expected">richtig: ${escapeHtml(detail.expected)}</span>` : ''}${result ? '' : '<span class="sort-buttons"><button type="button" data-move="up">↑</button><button type="button" data-move="down">↓</button></span>'}</div>`;
  }).join('')}</div><input type="hidden" name="order" value="${order.join(',')}"></div>`;
}

function renderImageDragDrop(question, response, result, presentationSeed) {
  const answer = question.answer || {};
  const imageAsset = (question.assets || []).find(asset => asset.id === answer.imageAssetId);
  const source = resolveAsset(imageAsset);
  let placements = {};
  try { placements = JSON.parse(responseOne(response, 'image_placements') || '{}'); } catch { placements = {}; }
  const items = new Map((answer.items || []).map(item => [String(item.id), String(item.text || '')]));
  const assigned = new Set(Object.values(placements).map(String));
  const targets = (answer.targets || []).map((target, index) => {
    const targetId = String(target.id);
    const itemId = String(placements[targetId] || '');
    const detail = result?.details?.find(item => item.targetId === targetId);
    const cls = detail ? (detail.correct ? 'is-correct' : 'is-wrong') : '';
    const expected = result && detail && !detail.correct ? `<span class="image-drop-expected">richtig: ${escapeHtml(detail.expected || 'leer')}</span>` : '';
    return `<button type="button" class="image-drop-target ${itemId ? 'has-value' : ''} ${cls}" data-image-target-id="${escapeHtml(targetId)}" data-image-item-id="${escapeHtml(itemId)}" data-image-x="${Number(target.x)}" data-image-y="${Number(target.y)}" data-image-width="${Number(target.width)}" data-image-height="${Number(target.height)}" ${result ? 'disabled' : ''}><span class="image-drop-value">${itemId ? escapeHtml(items.get(itemId) || itemId) : `<span class="image-drop-empty">${index + 1}</span>`}</span>${expected}</button>`;
  }).join('');
  const presentedItems = shuffledValues(answer.items || [], presentationSeed, 'image-drag-drop:items');
  const pool = result ? '' : `<div class="image-item-pool" data-image-item-pool>${presentedItems.filter(item => !assigned.has(String(item.id))).map(item => `<button type="button" class="image-drag-item" draggable="true" data-image-item-id="${escapeHtml(item.id)}">${escapeHtml(item.text)}</button>`).join('')}</div>`;
  const image = source ? `<div class="image-drop-stage"><img src="${escapeHtml(source)}" alt="Interaktionsbild">${targets}</div>` : '<div class="asset-warning">⚠ Das benötigte Interaktionsbild fehlt.</div>';
  return `<div class="image-drag-drop" data-checked="${result ? '1' : '0'}">${image}${result ? '' : '<p class="interaction-hint">Begriff ziehen oder antippen, danach ein Ziel antippen. Ein belegtes Ziel kann erneut gewählt oder geleert werden.</p>'}<h3>Verfügbare Begriffe</h3>${pool}<input type="hidden" name="image_placements" value="${escapeHtml(JSON.stringify(placements))}"></div>`;
}

export function renderInteraction(question, response = {}, result = null, presentationSeed = '') {
  if (['single_choice', 'multiple_choice'].includes(question.type)) return renderChoice(question, response, result, presentationSeed);
  if (question.type === 'choice_matrix') return renderMatrix(question, response, result, presentationSeed);
  if (question.type === 'cloze') return renderCloze(question, response, result, presentationSeed);
  if (question.type === 'matching') return renderMatching(question, response, result, presentationSeed);
  if (question.type === 'ordering') return renderOrdering(question, response, result, presentationSeed);
  if (question.type === 'image_drag_drop') return renderImageDragDrop(question, response, result, presentationSeed);
  return '<div class="flash error">Dieser Fragentyp kann im Lernclient noch nicht automatisch dargestellt werden.</div>';
}

export function correctResponse(question) {
  const answer = question.answer || {};
  if (['single_choice', 'multiple_choice'].includes(question.type)) {
    return {choice: (answer.options || []).map((option, index) => option.correct ? String(index) : null).filter(value => value !== null)};
  }
  if (question.type === 'choice_matrix') {
    return Object.fromEntries((answer.groups || []).map((group, index) => [
      `group_${index}`,
      [String((group.options || []).findIndex(option => option.correct))],
    ]));
  }
  if (question.type === 'cloze') {
    let index = 0;
    return Object.fromEntries((answer.segments || []).filter(segment => segment.kind === 'gap').map(segment => [
      `gap_${index++}`,
      [String((segment.answers || [])[0] || '')],
    ]));
  }
  if (question.type === 'matching') {
    return Object.fromEntries((answer.left || []).map((left, index) => [
      `match_${index}`,
      (answer.pairs || []).filter(pair => normalizeText(pair.left) === normalizeText(left)).map(pair => String(pair.right || '')),
    ]));
  }
  if (question.type === 'ordering') {
    return {order: [(answer.items || []).map((_, index) => index).join(',')]};
  }
  if (question.type === 'image_drag_drop') {
    return {image_placements: [JSON.stringify(Object.fromEntries((answer.placements || []).map(item => [String(item.targetId), String(item.itemId)])))]};
  }
  return {};
}

export function renderCorrectSolution(question) {
  const response = correctResponse(question);
  return renderInteraction(question, response, evaluateAnswer(question, response)) + renderAssetsForRoles(question, new Set(['answer']));
}

export function collectResponse(container, question) {
  const response = {};
  if (['single_choice', 'multiple_choice'].includes(question.type)) {
    response.choice = [...container.querySelectorAll('input[name="choice"]:checked')].map(input => input.value);
  } else if (question.type === 'choice_matrix') {
    (question.answer.groups || []).forEach((_, index) => {
      const selected = container.querySelector(`input[name="group_${index}"]:checked`);
      response[`group_${index}`] = selected ? [selected.value] : [''];
    });
  } else if (question.type === 'cloze') {
    let index = 0;
    for (const segment of question.answer.segments || []) {
      if (segment.kind !== 'gap') continue;
      response[`gap_${index}`] = [container.querySelector(`[name="gap_${index}"]`)?.value || ''];
      index += 1;
    }
  } else if (question.type === 'matching') {
    if (question.answer?.interaction === 'lines') {
      const right = question.answer.right || [];
      (question.answer.left || []).forEach((_, index) => {
        const left = container.querySelector(`.line-left[data-left-index="${index}"]`);
        const indices = String(left?.dataset.currentIndices || '').split(',').filter(value => /^\d+$/.test(value)).map(Number);
        response[`match_${index}`] = indices.map(item => right[item]).filter(value => value !== undefined);
      });
    } else {
      (question.answer.left || []).forEach((_, index) => {
        response[`match_${index}`] = [container.querySelector(`[name="match_${index}"]`)?.value || ''];
      });
    }
  } else if (question.type === 'ordering') {
    response.order = [container.querySelector('[name="order"]')?.value || ''];
  } else if (question.type === 'image_drag_drop') {
    response.image_placements = [container.querySelector('[name="image_placements"]')?.value || '{}'];
  }
  return response;
}

export function renderFeedback(question, result) {
  if (!result) return '';
  const state = result.correct ? 'correct' : result.earned > 0 ? 'partial' : 'incorrect';
  const title = result.correct ? 'Ihre Antwort ist richtig.' : result.earned > 0 ? 'Ihre Antwort ist nur teilweise richtig.' : 'Ihre Antwort ist falsch.';
  const score = result.total > 1 ? `<span>${result.earned} von ${result.total} Teilantworten richtig</span>` : '';
  const feedback = question.feedback?.text || '';
  return `<div class="answer-feedback ${state}"><div class="answer-feedback-head"><strong>${title}</strong>${score}</div>${feedback ? `<div class="feedback-text">${escapeHtml(feedback)}</div>` : ''}${renderAssetsForRoles(question, new Set(['feedback']))}</div>`;
}

export function solutionLines(question) {
  const answer = question.answer || {};
  if (['single_choice', 'multiple_choice'].includes(question.type)) {
    return (answer.options || []).filter(option => option.correct).map(option => option.text || '');
  }
  if (question.type === 'choice_matrix') {
    return (answer.groups || []).map((group, index) => {
      const option = (group.options || []).find(item => item.correct);
      const label = group.prompt || (index === 0 ? question.prompt?.text : `Teilfrage ${index + 1}`) || `Teilfrage ${index + 1}`;
      return `${label} → ${option?.text || '?'}`;
    });
  }
  if (question.type === 'cloze') {
    let text = '';
    for (const segment of answer.segments || []) text += segment.kind === 'text' ? segment.text || '' : (segment.answers || []).join(' / ');
    return [text];
  }
  if (question.type === 'matching') {
    const lines = (answer.pairs || []).map(pair => `${pair.left} → ${pair.right}`);
    if (answer.interaction === 'lines') {
      const pairedLeft = new Set((answer.pairs || []).map(pair => normalizeText(pair.left)));
      const pairedRight = new Set((answer.pairs || []).map(pair => normalizeText(pair.right)));
      (answer.left || []).filter(value => !pairedLeft.has(normalizeText(value))).forEach(value => lines.push(`${value} → ohne Zuordnung`));
      (answer.right || []).filter(value => !pairedRight.has(normalizeText(value))).forEach(value => lines.push(`ohne Zuordnung ← ${value}`));
    }
    return lines;
  }
  if (question.type === 'ordering') return (answer.items || []).map((item, index) => `${index + 1}. ${item}`);
  if (question.type === 'image_drag_drop') {
    const items = new Map((answer.items || []).map(item => [String(item.id), String(item.text || '')]));
    return (answer.placements || []).map(item => `${items.get(String(item.itemId)) || '?'} → ${item.targetId}`);
  }
  return [];
}

export function searchableText(question) {
  const values = [];
  const collect = value => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(question.prompt); collect(question.instruction); collect(question.answer); collect(question.feedback);
  return normalizeText(values.join(' '));
}

export function wireQuestionInteractions(container) {
  container.querySelectorAll('.image-drop-target').forEach(target => {
    const geometry = {
      left: Number(target.dataset.imageX),
      top: Number(target.dataset.imageY),
      width: Number(target.dataset.imageWidth),
      height: Number(target.dataset.imageHeight),
    };
    Object.entries(geometry).forEach(([property, value]) => {
      if (Number.isFinite(value)) target.style[property] = `${value * 100}%`;
    });
  });

  container.querySelectorAll('.sortable-list[data-checked="0"]').forEach(list => {
    const hidden = list.parentElement?.querySelector('input[name="order"]');
    const update = () => {
      const items = [...list.querySelectorAll('.sortable-item')];
      items.forEach((item, index) => { const pos = item.querySelector('.sort-position'); if (pos) pos.textContent = String(index + 1); });
      if (hidden) hidden.value = items.map(item => item.dataset.itemIndex).join(',');
    };
    let dragging = null;
    list.querySelectorAll('.sortable-item').forEach(item => {
      item.addEventListener('dragstart', () => { dragging = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); dragging = null; update(); });
    });
    list.addEventListener('dragover', event => {
      event.preventDefault(); if (!dragging) return;
      const candidates = [...list.querySelectorAll('.sortable-item:not(.dragging)')];
      const after = candidates.find(candidate => event.clientY <= candidate.getBoundingClientRect().top + candidate.offsetHeight / 2);
      if (after) list.insertBefore(dragging, after); else list.appendChild(dragging);
    });
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-move]'); if (!button) return;
      const item = button.closest('.sortable-item'); if (!item) return;
      if (button.dataset.move === 'up' && item.previousElementSibling) list.insertBefore(item, item.previousElementSibling);
      if (button.dataset.move === 'down' && item.nextElementSibling) list.insertBefore(item.nextElementSibling, item);
      update();
    });
    update();
  });

  container.querySelectorAll('.learning-drag-match[data-checked="0"]').forEach(match => {
    const pool = match.querySelector('.match-token-list');
    let selectedToken = null;
    const tokenFor = value => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'match-token'; button.draggable = true; button.dataset.value = value; button.textContent = value; wireToken(button); return button;
    };
    const setSelected = token => { if (selectedToken) selectedToken.classList.remove('selected-token'); selectedToken = token; if (selectedToken) selectedToken.classList.add('selected-token'); };
    const assign = (target, value) => {
      const input = document.getElementById(target.dataset.inputId || ''); if (!input) return;
      const old = input.value; if (old && old !== value && pool) pool.appendChild(tokenFor(old));
      match.querySelectorAll('.match-answer').forEach(other => {
        if (other === target) return;
        const otherInput = document.getElementById(other.dataset.inputId || '');
        if (otherInput?.value === value) { otherInput.value = ''; other.innerHTML = '<span class="match-empty">?</span>'; other.classList.remove('has-value'); }
      });
      input.value = value; target.textContent = value; target.classList.add('has-value');
      if (selectedToken?.dataset.value === value) selectedToken.remove(); setSelected(null);
    };
    function wireToken(token) {
      token.addEventListener('click', () => setSelected(selectedToken === token ? null : token));
      token.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', token.dataset.value || ''); setSelected(token); });
    }
    match.querySelectorAll('.match-token').forEach(wireToken);
    match.querySelectorAll('.match-answer').forEach(target => {
      target.addEventListener('dragover', event => event.preventDefault());
      target.addEventListener('drop', event => { event.preventDefault(); const value = event.dataTransfer.getData('text/plain'); if (value) assign(target, value); });
      target.addEventListener('click', () => {
        if (selectedToken) return assign(target, selectedToken.dataset.value || '');
        const input = document.getElementById(target.dataset.inputId || '');
        if (input?.value) { if (pool) pool.appendChild(tokenFor(input.value)); input.value = ''; target.innerHTML = '<span class="match-empty">?</span>'; target.classList.remove('has-value'); }
      });
    });
  });

  container.querySelectorAll('.image-drag-drop[data-checked="0"]').forEach(interaction => {
    const pool = interaction.querySelector('[data-image-item-pool]');
    const hidden = interaction.querySelector('[name="image_placements"]');
    let selected = null;
    const placements = () => Object.fromEntries([...interaction.querySelectorAll('[data-image-target-id]')]
      .filter(target => target.dataset.imageItemId)
      .map(target => [target.dataset.imageTargetId, target.dataset.imageItemId]));
    const sync = () => { if (hidden) hidden.value = JSON.stringify(placements()); };
    const setSelected = token => {
      selected?.classList.remove('selected-token'); selected = selected === token ? null : token;
      selected?.classList.add('selected-token');
    };
    const makeToken = (id, label) => {
      const token = document.createElement('button'); token.type = 'button'; token.className = 'image-drag-item'; token.draggable = true; token.dataset.imageItemId = id; token.textContent = label;
      wireToken(token); return token;
    };
    const clearTarget = target => {
      const oldId = target.dataset.imageItemId; const oldLabel = target.querySelector('.image-drop-value')?.textContent || oldId;
      if (oldId && pool) pool.append(makeToken(oldId, oldLabel));
      target.dataset.imageItemId = ''; target.classList.remove('has-value');
      const value = target.querySelector('.image-drop-value'); if (value) value.innerHTML = '<span class="image-drop-empty">?</span>';
      sync();
    };
    const assign = (target, token) => {
      if (!target || !token) return;
      const id = token.dataset.imageItemId || ''; const label = token.textContent || id;
      interaction.querySelectorAll('[data-image-target-id]').forEach(other => { if (other !== target && other.dataset.imageItemId === id) clearTarget(other); });
      if (target.dataset.imageItemId && target.dataset.imageItemId !== id) clearTarget(target);
      target.dataset.imageItemId = id; target.classList.add('has-value');
      const value = target.querySelector('.image-drop-value'); if (value) value.textContent = label;
      token.remove(); selected = null; sync();
    };
    function wireToken(token) {
      token.addEventListener('click', () => setSelected(token));
      token.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', token.dataset.imageItemId || ''); setSelected(token); });
    }
    pool?.querySelectorAll('.image-drag-item').forEach(wireToken);
    interaction.querySelectorAll('[data-image-target-id]').forEach(target => {
      target.addEventListener('dragover', event => event.preventDefault());
      target.addEventListener('drop', event => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); const token = [...(pool?.querySelectorAll('.image-drag-item') || [])].find(item => item.dataset.imageItemId === id) || selected; assign(target, token); });
      target.addEventListener('click', () => selected ? assign(target, selected) : clearTarget(target));
    });
    sync();
  });

  container.querySelectorAll('.learning-line-match').forEach(matcher => {
    const surface = matcher.querySelector('.line-surface');
    const checked = matcher.dataset.checked === '1';
    let selectedLeft = null, pointerLeft = null;
    const rightByIndex = index => matcher.querySelector(`.line-right[data-right-index="${index}"]`);
    const parseIndices = value => String(value || '').split(',').filter(item => /^\d+$/.test(item)).map(Number);
    const setIndices = (left, values) => { left.dataset.currentIndices = [...new Set(values)].join(','); };
    const center = element => { const root = matcher.getBoundingClientRect(); const port = element.querySelector('.line-port'); const rect = (port || element).getBoundingClientRect(); return {x: rect.left + rect.width / 2 - root.left, y: rect.top + rect.height / 2 - root.top}; };
    const selectLeft = left => { if (selectedLeft) selectedLeft.classList.remove('selected-line'); selectedLeft = left; if (left) left.classList.add('selected-line'); };
    const drawLine = (left, right, cls, deletable = false, rightIndex = null) => {
      if (!surface || !left || !right) return;
      const a = center(left), b = center(right);
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.setAttribute('class', `line-link${deletable ? ' deletable' : ''}`);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      [['x1',a.x],['y1',a.y],['x2',b.x],['y2',b.y]].forEach(([key,value]) => line.setAttribute(key, value)); if (cls) line.setAttribute('class', cls); group.appendChild(line);
      if (deletable) {
        const hit = line.cloneNode(); hit.setAttribute('class','line-link-hit'); group.appendChild(hit);
        const remove = document.createElementNS('http://www.w3.org/2000/svg','g'); remove.setAttribute('class','line-delete'); remove.setAttribute('transform',`translate(${(a.x+b.x)/2} ${(a.y+b.y)/2})`);
        const circle = document.createElementNS('http://www.w3.org/2000/svg','circle'); circle.setAttribute('r','11');
        const text = document.createElementNS('http://www.w3.org/2000/svg','text'); text.textContent='×'; remove.append(circle,text); group.appendChild(remove);
        remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); setIndices(left, parseIndices(left.dataset.currentIndices).filter(index => index !== rightIndex)); selectLeft(null); draw(); });
      }
      surface.appendChild(group);
    };
    const draw = () => {
      if (!surface) return; surface.replaceChildren();
      matcher.querySelectorAll('.line-left').forEach(left => {
        const current = parseIndices(left.dataset.currentIndices);
        const correct = new Set(parseIndices(left.dataset.correctIndices));
        current.forEach(index => drawLine(left, rightByIndex(index), checked ? (correct.has(index) ? 'correct' : 'wrong') : '', !checked, index));
        if (checked) [...correct].filter(index => !current.includes(index)).forEach(index => drawLine(left, rightByIndex(index), 'expected'));
      });
    };
    const assign = (left,right) => {
      if (checked || !left || !right) return;
      const index = Number(right.dataset.rightIndex);
      if (!Number.isInteger(index)) return;
      const current = parseIndices(left.dataset.currentIndices);
      if (!current.includes(index)) setIndices(left, [...current, index]);
      selectLeft(null); draw();
    };
    if (!checked) {
      matcher.querySelectorAll('.line-left').forEach(left => { left.addEventListener('click',()=>selectLeft(selectedLeft===left?null:left)); left.addEventListener('pointerdown',()=>{pointerLeft=left;selectLeft(left);}); });
      matcher.querySelectorAll('.line-right').forEach(right => { right.addEventListener('click',()=>{if(selectedLeft)assign(selectedLeft,right);}); right.addEventListener('pointerup',()=>{if(pointerLeft)assign(pointerLeft,right);pointerLeft=null;}); });
      matcher.querySelector('.line-clear')?.addEventListener('click',()=>{ matcher.querySelectorAll('.line-left').forEach(left=>setIndices(left,[])); selectLeft(null); draw(); });
    }
    draw();
    const resize = () => draw(); window.addEventListener('resize', resize, {passive:true});
  });
}
