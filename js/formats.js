import {SCHEDULER_VERSION, SUPPORTED_SCHEDULER_VERSIONS} from './scheduler.js';

export const BANK_FORMAT = 'lerndatenbank.bank';
export const BACKUP_FORMAT = 'lerndatenbank.backup';
export const FORMAT_VERSION = 2;
export const SUPPORTED_FORMAT_VERSIONS = new Set([1, 2]);
const MAX_FILE_BYTES = 250 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBankCore(payload) {
  if (!isObject(payload.bank) || typeof payload.bank.id !== 'string' || !payload.bank.id.trim()) {
    throw new Error('Die Datei enthält keine gültige Bank-ID.');
  }
  if (!Array.isArray(payload.questions)) throw new Error('Die Datei enthält keine Fragenliste.');
  const ids = new Set();
  for (const question of payload.questions) {
    if (!isObject(question) || typeof question.id !== 'string' || !question.id) throw new Error('Mindestens eine Frage hat keine stabile ID.');
    if (ids.has(question.id)) throw new Error(`Doppelte Fragen-ID: ${question.id}`);
    ids.add(question.id);
    if (typeof question.type !== 'string' || !isObject(question.answer)) throw new Error(`Ungültige Frage: ${question.id}`);
  }
}

export function validatePayload(payload) {
  if (!isObject(payload)) throw new Error('Die Datei enthält kein JSON-Objekt.');
  if (!SUPPORTED_FORMAT_VERSIONS.has(payload.formatVersion)) {
    throw new Error(`Nicht unterstützte Formatversion: ${payload.formatVersion ?? 'unbekannt'}.`);
  }
  if (![BANK_FORMAT, BACKUP_FORMAT].includes(payload.format)) throw new Error('Unbekanntes Lerndatenbank-Dateiformat.');
  validateBankCore(payload);
  if (payload.formatVersion === 2 && !isObject(payload.assets)) {
    throw new Error('Die Version-2-Datei enthält keinen zentralen Asset-Store.');
  }
  if (payload.formatVersion === 2) {
    for (const [id, asset] of Object.entries(payload.assets)) {
      if (!isObject(asset) || asset.kind !== 'image' || typeof asset.mimeType !== 'string' || !asset.mimeType.startsWith('image/') || typeof asset.dataBase64 !== 'string') {
        throw new Error(`Ungültiges eingebettetes Asset: ${id}`);
      }
    }
    for (const question of payload.questions) {
      for (const reference of question.assets || []) {
        const role = reference?.role === 'question' ? 'prompt' : reference?.role;
        if (['prompt', 'interaction-background'].includes(role) && !payload.assets[reference.id]) {
          throw new Error(`Pflichtbild ${reference.id || 'unbekannt'} für Frage ${question.id} fehlt.`);
        }
      }
    }
  }
  if (payload.format === BACKUP_FORMAT) {
    if (!isObject(payload.progress)) throw new Error('Das Backup enthält keinen Lernfortschritt.');
    if (!SUPPORTED_SCHEDULER_VERSIONS.has(payload.progress.schedulerVersion)) {
      throw new Error(`Nicht unterstützte Scheduler-Version: ${payload.progress.schedulerVersion ?? 'unbekannt'}.`);
    }
  }
  return payload;
}

export async function readLearningFile(file) {
  if (!file) throw new Error('Keine Datei ausgewählt.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Die Datei ist größer als 250 MB und wird aus Sicherheitsgründen nicht geladen.');
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    throw new Error(`Die Datei ist kein gültiges JSON: ${error.message}`);
  }
  return validatePayload(payload);
}

export function backupFromWorkspace(workspace) {
  return {
    format: BACKUP_FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    bank: {...workspace.bank, questionCount: workspace.questions.length},
    assets: workspace.assets || {},
    questions: workspace.questions,
    progress: {
      schedulerVersion: SCHEDULER_VERSION,
      cards: workspace.cards || {},
      reviews: workspace.reviews || [],
    },
    settings: workspace.settings || {},
  };
}

function safeName(value) {
  return String(value || 'lerndatenbank')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'lerndatenbank';
}

export function downloadBackup(workspace) {
  const payload = backupFromWorkspace(workspace);
  const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], {type: 'application/vnd.lerndatenbank.backup+json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `${safeName(workspace.bank?.name)}-${date}.lernbackup`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
