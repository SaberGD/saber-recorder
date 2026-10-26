// الربط بالسيستم والرفع على Drive الأكاديمية.
// المدرب بيربط الإكستنشن بحسابه على السيستم مرة واحدة، والسيستم هو اللي بيفتح جلسة الرفع
// في فولدر المحاضرة على Drive الأكاديمية. الإكستنشن مبتشوفش أي توكن جوجل.

import { CONFIG } from '../config.js';

const AUTH_KEY = 'systemAuth'; // { token, name, email, linkedAt }

export class SystemAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SystemAuthError';
  }
}

export class UploadSessionExpiredError extends Error {
  constructor() {
    super('جلسة الرفع على Drive انتهت');
    this.name = 'UploadSessionExpiredError';
  }
}

export async function getSystemAccount() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  return auth?.token ? { name: auth.name || '', email: auth.email || '' } : null;
}

export async function saveSystemLink({ token, name, email }) {
  if (!/^srec_[A-Za-z0-9_-]{20,}$/.test(token || '')) throw new Error('بيانات الربط غير صحيحة');
  await chrome.storage.local.set({ [AUTH_KEY]: { token, name: name || '', email: email || '', linkedAt: new Date().toISOString() } });
}

export async function unlinkSystem() {
  await api('/unlink', { method: 'POST' }).catch(() => {});
  await chrome.storage.local.remove(AUTH_KEY);
}

async function api(path, init = {}) {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (!auth?.token) throw new SystemAuthError('اربط الإكستنشن بحسابك على السيستم الأول');
  let res;
  try {
    res = await fetch(`${CONFIG.RECORDER_API}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${auth.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch {
    const err = new Error(navigator.onLine ? 'تعذر الاتصال بالسيستم' : 'مفيش اتصال بالإنترنت');
    err.retryable = true;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new SystemAuthError(body.error || 'محتاج تربط الإكستنشن بالسيستم تاني');
  if (!res.ok) {
    const err = new Error(body.error || `السيستم رد بخطأ (${res.status})`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return body;
}

export const listGroups = () => api('/groups').then((r) => r.groups);
export const listSessions = (groupId) => api(`/groups/${encodeURIComponent(groupId)}/sessions`).then((r) => r.sessions);
export const detectLecture = (meetUrl) => api(`/detect?meet=${encodeURIComponent(meetUrl || '')}`).then((r) => r.match);

export function completeUpload(recordingId, payload) {
  return api(`/uploads/${encodeURIComponent(recordingId)}/complete`, { method: 'POST', body: JSON.stringify(payload) });
}

// بيفتح جلسة الرفع في فولدر المحاضرة. بيرجع { uploadUrl, recordingId, folderPath }
export async function createUploadSession(rec) {
  if (!rec.lecture?.groupId || !rec.lecture?.sessionId) throw new Error('التسجيل ده مش متحدد له محاضرة');
  return api('/uploads', {
    method: 'POST',
    body: JSON.stringify({
      groupId: rec.lecture.groupId,
      sessionId: rec.lecture.sessionId,
      mimeType: rec.mimeType.split(';')[0],
      recordedAt: new Date(rec.createdAt).toISOString(),
    }),
  });
}

// الرفع نفسه على رابط الجلسة بتاع Drive مباشرة: الرابط هو الصلاحية، فمفيش توكن.
// total = null معناها لسه منعرفش الحجم النهائي (التسجيل شغال).
export async function uploadChunk(sessionUri, { start, data, total }) {
  const end = start + data.byteLength - 1;
  const range = data.byteLength ? `bytes ${start}-${end}/${total ?? '*'}` : `bytes */${total ?? '*'}`;
  return parseUploadResponse(await fetch(sessionUri, { method: 'PUT', headers: { 'Content-Range': range }, body: data }));
}

export async function queryUploadStatus(sessionUri, total = null) {
  return parseUploadResponse(await fetch(sessionUri, { method: 'PUT', headers: { 'Content-Range': `bytes */${total ?? '*'}` } }));
}

async function parseUploadResponse(res) {
  if (res.status === 200 || res.status === 201) return { file: await res.json() };
  if (res.status === 308) {
    const range = res.headers.get('Range');
    return { uploaded: range ? Number(range.split('-')[1]) + 1 : 0 };
  }
  if (res.status === 404 || res.status === 410) throw new UploadSessionExpiredError();
  const err = new Error(`Drive رد بخطأ (${res.status})`);
  err.retryable = res.status >= 500 || res.status === 429 || res.status === 408;
  throw err;
}
