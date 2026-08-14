import test from 'node:test';
import assert from 'node:assert/strict';

import {evaluateAnswer, resolveAsset, setAssetStore} from './js/questions.js';
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
