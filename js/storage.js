import {SCHEDULER_VERSION, migrateWorkspaceScheduler} from './scheduler.js';

const DB_NAME = 'lerndatenbank-client';
const DB_VERSION = 1;
const WORKSPACES = 'workspaces';
const META = 'meta';

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB-Transaktion abgebrochen.'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB-Fehler.'));
  });
}

export async function openDatabase() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(WORKSPACES)) {
      db.createObjectStore(WORKSPACES, {keyPath: 'id'});
    }
    if (!db.objectStoreNames.contains(META)) {
      db.createObjectStore(META, {keyPath: 'key'});
    }
  };
  return requestPromise(request);
}

export async function getWorkspace(bankId) {
  if (!bankId) return null;
  const db = await openDatabase();
  let stored;
  try {
    const tx = db.transaction(WORKSPACES, 'readonly');
    stored = await requestPromise(tx.objectStore(WORKSPACES).get(bankId)) || null;
  } finally {
    db.close();
  }
  if (!stored) return null;
  const migration = migrateWorkspaceScheduler(stored);
  if (migration.migrated) await saveWorkspace(migration.workspace);
  return migration.workspace;
}

export async function saveWorkspace(workspace) {
  workspace.updatedAt = new Date().toISOString();
  const db = await openDatabase();
  try {
    const tx = db.transaction(WORKSPACES, 'readwrite');
    tx.objectStore(WORKSPACES).put(workspace);
    await transactionPromise(tx);
  } finally {
    db.close();
  }
}

export async function listWorkspaces() {
  const db = await openDatabase();
  try {
    const tx = db.transaction(WORKSPACES, 'readonly');
    const rows = await requestPromise(tx.objectStore(WORKSPACES).getAll());
    return rows.sort((a, b) => String(a.bank?.name || '').localeCompare(String(b.bank?.name || ''), 'de'));
  } finally {
    db.close();
  }
}

export async function deleteWorkspace(bankId) {
  const db = await openDatabase();
  try {
    const tx = db.transaction([WORKSPACES, META], 'readwrite');
    tx.objectStore(WORKSPACES).delete(bankId);
    const active = await requestPromise(tx.objectStore(META).get('activeBankId'));
    if (active?.value === bankId) tx.objectStore(META).delete('activeBankId');
    await transactionPromise(tx);
  } finally {
    db.close();
  }
}

export async function setActiveBankId(bankId) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(META, 'readwrite');
    if (bankId) tx.objectStore(META).put({key: 'activeBankId', value: bankId});
    else tx.objectStore(META).delete('activeBankId');
    await transactionPromise(tx);
  } finally {
    db.close();
  }
}

export async function getActiveBankId() {
  const db = await openDatabase();
  try {
    const tx = db.transaction(META, 'readonly');
    const row = await requestPromise(tx.objectStore(META).get('activeBankId'));
    return row?.value || null;
  } finally {
    db.close();
  }
}

export async function getActiveWorkspace() {
  const id = await getActiveBankId();
  return id ? getWorkspace(id) : null;
}

export async function importBankPayload(payload) {
  const existing = await getWorkspace(payload.bank.id);
  const validIds = new Set(payload.questions.map(question => question.id));
  const cards = {};
  if (existing?.cards) {
    for (const [questionId, card] of Object.entries(existing.cards)) {
      if (validIds.has(questionId)) cards[questionId] = card;
    }
  }
  const reviews = (existing?.reviews || []).filter(review => validIds.has(review.questionId));
  const candidate = {
    id: payload.bank.id,
    schedulerVersion: SCHEDULER_VERSION,
    bank: payload.bank,
    assets: payload.assets || {},
    questions: payload.questions,
    cards,
    reviews,
    settings: existing?.settings || {},
    importedAt: new Date().toISOString(),
  };
  const {workspace} = migrateWorkspaceScheduler(candidate);
  await saveWorkspace(workspace);
  await setActiveBankId(workspace.id);
  return {workspace, preservedCards: Object.keys(cards).length, preservedReviews: reviews.length, updated: Boolean(existing)};
}

export async function importBackupPayload(payload) {
  const validIds = new Set(payload.questions.map(question => question.id));
  const cards = Object.fromEntries(
    Object.entries(payload.progress?.cards || {}).filter(([questionId]) => validIds.has(questionId))
  );
  const reviews = (payload.progress?.reviews || []).filter(review => validIds.has(review.questionId));
  const legacyWorkspace = {
    id: payload.bank.id,
    schedulerVersion: payload.progress.schedulerVersion,
    bank: payload.bank,
    assets: payload.assets || {},
    questions: payload.questions,
    cards,
    reviews,
    settings: payload.settings || {},
    importedAt: new Date().toISOString(),
  };
  const {workspace} = migrateWorkspaceScheduler(legacyWorkspace);
  await saveWorkspace(workspace);
  await setActiveBankId(workspace.id);
  return workspace;
}
