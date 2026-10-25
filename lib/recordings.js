// بيانات التسجيلات (مش الفيديو نفسه) محفوظة في chrome.storage.local تحت مفتاح واحد.
// الفيديو نفسه في OPFS باسم rec.fileName لحد ما يتحفظ محليًا و/أو يترفع.

const KEY = 'recordings';
const MAX_DONE_KEPT = 20;

// حالات التسجيل:
// recording   شغال دلوقتي
// interrupted اللوحة اتقفلت أو الجهاز فصل أثناء التسجيل (اللي اتسجل محفوظ)
// finishing   خلص تسجيل ولسه بيتحفظ/بيترفع
// done        خلص كل حاجة واتمسح من الجهاز المؤقت
// failed      فيه خطوة فشلت ومحتاجة تدخل (rec.error فيه السبب)

async function readAll() {
  const { [KEY]: all } = await chrome.storage.local.get(KEY);
  return all || {};
}

export async function listRecordings() {
  const all = await readAll();
  return Object.values(all).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id) {
  return (await readAll())[id] || null;
}

export async function saveRecording(rec) {
  const all = await readAll();
  all[rec.id] = { ...all[rec.id], ...rec, updatedAt: Date.now() };
  pruneDone(all);
  await chrome.storage.local.set({ [KEY]: all });
  return all[rec.id];
}

export async function patchRecording(id, patch) {
  const all = await readAll();
  if (!all[id]) return null;
  all[id] = deepMerge(all[id], patch);
  all[id].updatedAt = Date.now();
  await chrome.storage.local.set({ [KEY]: all });
  return all[id];
}

export async function removeRecording(id) {
  const all = await readAll();
  const rec = all[id];
  delete all[id];
  await chrome.storage.local.set({ [KEY]: all });
  if (rec?.fileName) await deleteLocalTemp(rec.fileName);
}

export async function deleteLocalTemp(fileName) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName);
  } catch {
    // الملف مش موجود أو لسه مقفول في تاب تانية، مش مشكلة
  }
}

// التسجيل اللي لوحته مفتوحة دلوقتي مش محتاج تدخل، اللوحة شغالة عليه
export function needsAttention(rec, activeRecId) {
  if (rec.id === activeRecId) return false;
  return rec.status === 'interrupted' || rec.status === 'failed' || rec.status === 'finishing'
    || rec.status === 'recording';
}

export async function getActiveRecorder() {
  const { activeRecorder } = await chrome.storage.local.get('activeRecorder');
  if (!activeRecorder) return null;
  try {
    await chrome.windows.get(activeRecorder.windowId);
    return activeRecorder;
  } catch {
    await chrome.storage.local.remove('activeRecorder');
    return null;
  }
}

function pruneDone(all) {
  const done = Object.values(all)
    .filter((r) => r.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const r of done.slice(MAX_DONE_KEPT)) delete all[r.id];
}

function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object'
      ? deepMerge(target[k], v)
      : v;
  }
  return out;
}

// علامات LRI/PDI علشان "120 MB" متتقلبش جوه النص العربي
export function formatBytes(bytes) {
  let text;
  if (!bytes) text = '0 MB';
  else if (bytes >= 1024 ** 3) text = `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  else text = `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `\u2066${text}\u2069`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
