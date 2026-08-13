export const BANK_FORMAT = 'lerndatenbank.bank';
export const BACKUP_FORMAT = 'lerndatenbank.backup';
export const FORMAT_VERSION = 1;
export const SCHEDULER_VERSION = 1;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

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
  if (payload.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Nicht unterstützte Formatversion: ${payload.formatVersion ?? 'unbekannt'}.`);
  }
  if (![BANK_FORMAT, BACKUP_FORMAT].includes(payload.format)) throw new Error('Unbekanntes Lerndatenbank-Dateiformat.');
  validateBankCore(payload);
  if (payload.format === BACKUP_FORMAT) {
    if (!isObject(payload.progress)) throw new Error('Das Backup enthält keinen Lernfortschritt.');
    if (payload.progress.schedulerVersion !== SCHEDULER_VERSION) {
      throw new Error(`Nicht unterstützte Scheduler-Version: ${payload.progress.schedulerVersion ?? 'unbekannt'}.`);
    }
  }
  return payload;
}

export async function readLearningFile(file) {
  if (!file) throw new Error('Keine Datei ausgewählt.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Die Datei ist größer als 50 MB und wird aus Sicherheitsgründen nicht geladen.');
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
