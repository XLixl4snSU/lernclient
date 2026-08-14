import test from 'node:test';
import assert from 'node:assert/strict';

import {correctResponse, evaluateAnswer, renderInteraction, resolveAsset, setAssetStore, solutionLines} from './js/questions.js';
import {validatePayload} from './js/formats.js';

const question = {
  id: 'q_image',
  type: 'image_drag_drop',
  answer: {
    imageAssetId: 'asset_hash',
    items: [{id: 'client', text: 'Client'}, {id: 'server', text: 'Server'}, {id: 'extra', text: 'Distraktor'}],
    targets: [
      {id: 'left', shape: 'rect', x: .1, y: .2, width: .2, height: .1},
      {id: 'right', shape: 'rect', x: .6, y: .2, width: .2, height: .1},
    ],
    placements: [{itemId: 'client', targetId: 'left'}, {itemId: 'server', targetId: 'right'}],
  },
  assets: [{id: 'asset_hash', kind: 'image', role: 'interaction-background', sha256: 'hash'}],
};

test('image_drag_drop evaluates complete and partial answers', () => {
  const correct = evaluateAnswer(question, {image_placements: [JSON.stringify({left: 'client', right: 'server'})]});
  assert.equal(correct.correct, true);
  assert.equal(correct.earned, 2);

  const partial = evaluateAnswer(question, {image_placements: [JSON.stringify({left: 'client', right: 'extra'})]});
  assert.equal(partial.correct, false);
  assert.equal(partial.earned, 1);
  assert.equal(partial.total, 2);

  setAssetStore({asset_hash: {kind: 'image', mimeType: 'image/png', dataBase64: 'aGVsbG8='}});
  const html = renderInteraction(question);
  setAssetStore({});
  assert.match(html, /data-image-x="0\.1"/);
  assert.doesNotMatch(html, /style=/);
});

test('embedded assets are resolved centrally', () => {
  setAssetStore({asset_hash: {kind: 'image', mimeType: 'image/png', dataBase64: 'aGVsbG8='}});
  assert.equal(resolveAsset({id: 'asset_hash', sourceUrl: 'https://remote.invalid/image.png'}), 'data:image/png;base64,aGVsbG8=');
  setAssetStore({});
  assert.equal(resolveAsset({id: 'asset_hash', sourceUrl: 'https://remote.invalid/image.png'}), '');
});

test('format versions 1 and 2 remain loadable', () => {
  const core = {format: 'lerndatenbank.bank', bank: {id: 'bank', name: 'Test'}, questions: [{id: 'q', type: 'single_choice', answer: {options: []}}]};
  assert.equal(validatePayload({...core, formatVersion: 1}).formatVersion, 1);
  assert.equal(validatePayload({...core, formatVersion: 2, assets: {}}).formatVersion, 2);
  assert.throws(() => validatePayload({...core, formatVersion: 2}), /Asset-Store/);
});

test('line matching supports cards without a correct connection', () => {
  const matching = {
    id: 'q_matching_distractors',
    type: 'matching',
    answer: {
      interaction: 'lines',
      left: ['Dokumentbibliothek', 'Ohne linke Lösung'],
      right: ['Speichert Dokumente', 'Unpassende Definition'],
      pairs: [{left: 'Dokumentbibliothek', right: 'Speichert Dokumente'}],
    },
  };
  const correct = correctResponse(matching);
  assert.deepEqual(correct, {match_0: ['Speichert Dokumente'], match_1: []});
  assert.equal(evaluateAnswer(matching, correct).correct, true);
  assert.equal(evaluateAnswer(matching, {match_0: ['Speichert Dokumente', 'Unpassende Definition'], match_1: []}).correct, false);

  const unanswered = renderInteraction(matching);
  assert.match(unanswered, /Unpassende Definition/);
  assert.doesNotMatch(unanswered, /ohne Zuordnung/);
  const revealed = renderInteraction(matching, correct, evaluateAnswer(matching, correct));
  assert.match(revealed, /line-unmatched-label/);
  assert.deepEqual(solutionLines(matching), [
    'Dokumentbibliothek → Speichert Dokumente',
    'Ohne linke Lösung → ohne Zuordnung',
    'ohne Zuordnung ← Unpassende Definition',
  ]);
});

test('line matching supports one-to-many and many-to-one connections', () => {
  const matching = {
    id: 'q_matching_many',
    type: 'matching',
    answer: {
      interaction: 'lines',
      left: ['L1', 'L2'],
      right: ['R1', 'R2'],
      pairs: [
        {left: 'L1', right: 'R1'},
        {left: 'L1', right: 'R2'},
        {left: 'L2', right: 'R2'},
      ],
    },
  };
  const correct = correctResponse(matching);
  assert.deepEqual(correct, {match_0: ['R1', 'R2'], match_1: ['R2']});
  assert.equal(evaluateAnswer(matching, correct).correct, true);
  assert.equal(evaluateAnswer(matching, {match_0: ['R1'], match_1: ['R2']}).correct, false);
  assert.equal(evaluateAnswer(matching, {match_0: ['R1', 'R2'], match_1: ['R1']}).correct, false);
  assert.match(renderInteraction(matching, {}, null, 'attempt-many'), /Mehrere Linien pro Karte sind auf beiden Seiten möglich/);
  assert.deepEqual(solutionLines(matching), ['L1 → R1', 'L1 → R2', 'L2 → R2']);
});

test('answer presentations shuffle deterministically without changing answer identities', () => {
  const indices = (html, pattern) => [...html.matchAll(pattern)].map(match => Number(match[1]));
  const choice = {
    id: 'q_choice', type: 'single_choice',
    answer: {options: [{text: 'A', correct: true}, {text: 'B', correct: false}, {text: 'C', correct: false}]},
  };
  const choiceFirst = renderInteraction(choice, {}, null, 'attempt-1');
  const choiceAgain = renderInteraction(choice, {}, null, 'attempt-1');
  const choiceOrder = indices(choiceFirst, /name="choice" value="(\d+)"/g);
  assert.notDeepEqual(choiceOrder, [0, 1, 2]);
  assert.deepEqual(choiceOrder, indices(choiceAgain, /name="choice" value="(\d+)"/g));
  const choiceResult = evaluateAnswer(choice, {choice: ['0']});
  assert.equal(choiceResult.correct, true);
  assert.deepEqual(choiceOrder, indices(renderInteraction(choice, {choice: ['0']}, choiceResult, 'attempt-1'), /name="choice" value="(\d+)"/g));

  const matrix = {
    id: 'q_matrix', type: 'choice_matrix',
    answer: {groups: [{prompt: 'Teil', options: [{text: 'A', correct: true}, {text: 'B'}, {text: 'C'}]}]},
  };
  assert.notDeepEqual(indices(renderInteraction(matrix, {}, null, 'attempt-1'), /name="group_0" value="(\d+)"/g), [0, 1, 2]);

  const cloze = {
    id: 'q_cloze', type: 'cloze',
    answer: {segments: [{kind: 'text', text: 'Ein '}, {kind: 'gap', inputMode: 'select', answers: ['A'], options: ['A', 'B', 'C']}]},
  };
  const clozeHtml = renderInteraction(cloze, {}, null, 'attempt-1');
  const clozeOptions = [...clozeHtml.matchAll(/<option value="([ABC])"/g)].map(match => match[1]);
  assert.notDeepEqual(clozeOptions, ['A', 'B', 'C']);
  assert.match(clozeHtml, /^<div class="cloze-flow">Ein /);

  const lineMatch = {
    id: 'q_lines', type: 'matching',
    answer: {interaction: 'lines', left: ['L1', 'L2', 'L3'], right: ['R1', 'R2', 'R3'], pairs: [{left: 'L1', right: 'R1'}]},
  };
  const lineHtml = renderInteraction(lineMatch, {}, null, 'attempt-1');
  assert.notDeepEqual(indices(lineHtml, /data-left-index="(\d+)"/g), [0, 1, 2]);
  assert.notDeepEqual(indices(lineHtml, /data-right-index="(\d+)"/g), [0, 1, 2]);

  const dragMatch = {...lineMatch, id: 'q_drag_match', answer: {...lineMatch.answer, interaction: 'drag_drop'}};
  const dragHtml = renderInteraction(dragMatch, {}, null, 'attempt-1');
  assert.notDeepEqual(indices(dragHtml, /id="match_(\d+)"/g), [0, 1, 2]);
  assert.notDeepEqual(indices(dragHtml, /data-value="R(\d+)"/g), [1, 2, 3]);

  const imageMatch = {
    id: 'q_image_order', type: 'image_drag_drop', assets: [],
    answer: {imageAssetId: '', items: [{id: '0', text: 'A'}, {id: '1', text: 'B'}, {id: '2', text: 'C'}], targets: [], placements: []},
  };
  assert.notDeepEqual(indices(renderInteraction(imageMatch, {}, null, 'attempt-1'), /data-image-item-id="(\d+)"/g), [0, 1, 2]);

  const ordering = {id: 'q_order', type: 'ordering', answer: {items: ['A', 'B', 'C']}};
  assert.notDeepEqual(indices(renderInteraction(ordering, {}, null, 'attempt-1'), /data-item-index="(\d+)"/g), [0, 1, 2]);
});
