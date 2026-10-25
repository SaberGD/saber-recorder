// ربط Google Drive ورفع الملفات بالـ resumable upload.
// الصلاحية drive.file: الإكستنشن تشوف وتعدّل الملفات اللي هي رفعتها بس، مش Drive كله.

import { CONFIG } from '../config.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const AUTH_KEY = 'driveAuth';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveAuthError';
  }
}

export class UploadSessionExpiredError extends Error {
  constructor() {
    super('جلسة الرفع على Drive انتهت');
    this.name = 'UploadSessionExpiredError';
  }
}

export function isDriveConfigured() {
  return Boolean(CONFIG.OAUTH_CLIENT_ID);
}

export async function getDriveAccount() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  if (!auth?.email) return null;
  return {
    email: auth.email,
    sharedRootId: auth.sharedRootId || '',
    sharedRootName: auth.sharedRootName || '',
    sharedFolderWarning: auth.sharedFolderWarning || '',
  };
}

// interactive=true بيفتح نافذة تسجيل الدخول. من غيره بيحاول يجدد التوكن في الخلفية.
export async function getToken({ interactive = false } = {}) {
  if (!isDriveConfigured()) throw new DriveAuthError('لم يتم ضبط OAUTH_CLIENT_ID في config.js');

  const { [AUTH_KEY]: cached } = await chrome.storage.local.get(AUTH_KEY);
  if (cached?.token && cached.expiresAt - Date.now() > 2 * 60 * 1000) return cached.token;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CONFIG.OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', chrome.identity.getRedirectURL());
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('include_granted_scopes', 'true');
  if (cached?.email) url.searchParams.set('login_hint', cached.email);
  if (!interactive) url.searchParams.set('prompt', 'none');
  else if (!cached?.email) url.searchParams.set('prompt', 'select_account');

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: url.toString(),
      interactive,
      ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15000 }),
    });
  } catch (err) {
    throw new DriveAuthError(interactive ? `تعذر ربط حساب Google: ${err.message}` : 'محتاج تعيد ربط حساب Google');
  }

  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new DriveAuthError(params.get('error') || 'لم يتم استلام صلاحية من Google');

  const expiresAt = Date.now() + Number(params.get('expires_in') || 3600) * 1000;
  let email = cached?.email || '';
  if (!email) {
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => (r.ok ? r.json() : {}));
    email = info.email || '';
  }
  const { [AUTH_KEY]: latest } = await chrome.storage.local.get(AUTH_KEY);
  await chrome.storage.local.set({ [AUTH_KEY]: { folderId: '', ...latest, token, expiresAt, email } });
  return token;
}

export async function disconnectDrive() {
  const { [AUTH_KEY]: cached } = await chrome.storage.local.get(AUTH_KEY);
  await chrome.storage.local.remove(AUTH_KEY);
  if (cached?.token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(cached.token)}`, { method: 'POST' })
      .catch(() => {});
  }
}

async function authedFetch(url, init = {}) {
  let token = await getToken();
  let res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await clearCachedToken();
    token = await getToken();
    res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  }
  return res;
}

async function clearCachedToken() {
  const { [AUTH_KEY]: cached } = await chrome.storage.local.get(AUTH_KEY);
  if (cached) await chrome.storage.local.set({ [AUTH_KEY]: { ...cached, token: '', expiresAt: 0 } });
}

// مكان الرفع: لو المدرب اختار فولدر الأكاديمية من الـ Picker، بنرفع في فولدر باسم إيميله جواه.
// لو الفولدر ده مبقاش متاح (الشير اتشال أو اتمسح) بنرجع لـ Drive الشخصي ونسيب تحذير، والتسجيل مبيضيعش.
export async function ensureFolder() {
  const { [AUTH_KEY]: cached } = await chrome.storage.local.get(AUTH_KEY);
  if (cached?.sharedRootId) {
    try {
      return await ensureTrainerFolder(cached);
    } catch (err) {
      if (!(err instanceof SharedFolderUnavailableError)) throw err;
      await patchAuth({
        sharedRootId: '',
        sharedRootName: '',
        trainerFolderId: '',
        sharedFolderWarning: `فولدر الأكاديمية "${cached.sharedRootName || ''}" مبقاش متاح (الشير اتشال أو الفولدر اتمسح)، فالتسجيل بيترفع على Drive الشخصي. اختار الفولدر تاني أو كلّم الأدمن.`,
      });
    }
  }
  return ensurePersonalFolder();
}

async function ensurePersonalFolder() {
  const { [AUTH_KEY]: cached } = await chrome.storage.local.get(AUTH_KEY);
  if (cached?.folderId) {
    const res = await authedFetch(`${API}/files/${cached.folderId}?fields=id,trashed&supportsAllDrives=true`);
    if (res.ok && !(await res.json()).trashed) return cached.folderId;
  }

  // 'root' in parents: علشان منلقطش فولدر الأكاديمية لو اسمه نفس الاسم
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeQuery(CONFIG.DRIVE_FOLDER_NAME)}' and 'root' in parents and trashed=false`;
  const found = await authedFetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&supportsAllDrives=true`)
    .then((r) => (r.ok ? r.json() : { files: [] }));
  let folderId = found.files?.[0]?.id;

  if (!folderId) {
    const res = await authedFetch(`${API}/files?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CONFIG.DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    if (!res.ok) throw new Error(`تعذر إنشاء فولدر على Drive (${res.status})`);
    folderId = (await res.json()).id;
  }

  await patchAuth({ folderId });
  return folderId;
}

async function ensureTrainerFolder(auth) {
  const root = auth.sharedRootId;

  if (auth.trainerFolderId) {
    const res = await authedFetch(`${API}/files/${auth.trainerFolderId}?fields=id,trashed,parents&supportsAllDrives=true`);
    if (res.ok) {
      const folder = await res.json();
      if (!folder.trashed && folder.parents?.includes(root)) return folder.id;
    } else if (!isAccessError(res.status)) {
      throw new Error(`تعذر الوصول لفولدر المدرب على Drive (${res.status})`);
    }
  }

  const rootRes = await authedFetch(`${API}/files/${root}?fields=id,trashed,capabilities/canAddChildren&supportsAllDrives=true`);
  if (isAccessError(rootRes.status)) throw new SharedFolderUnavailableError();
  if (!rootRes.ok) throw new Error(`تعذر الوصول لفولدر الأكاديمية (${rootRes.status})`);
  const rootInfo = await rootRes.json();
  if (rootInfo.trashed || !rootInfo.capabilities?.canAddChildren) throw new SharedFolderUnavailableError();

  const name = auth.email || 'trainer';
  const q = `'${escapeQuery(root)}' in parents and name='${escapeQuery(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const listRes = await authedFetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
    + '&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives');
  if (isAccessError(listRes.status)) throw new SharedFolderUnavailableError();
  if (!listRes.ok) throw new Error(`تعذر البحث في فولدر الأكاديمية (${listRes.status})`);
  let folderId = (await listRes.json()).files?.[0]?.id;

  if (!folderId) {
    const res = await authedFetch(`${API}/files?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [root] }),
    });
    if (isAccessError(res.status)) throw new SharedFolderUnavailableError();
    if (!res.ok) throw new Error(`تعذر إنشاء فولدر المدرب (${res.status})`);
    folderId = (await res.json()).id;
  }

  await patchAuth({ trainerFolderId: folderId });
  return folderId;
}

// بتتنادى بعد ما المدرب يختار فولدر الأكاديمية من صفحة الـ Picker
export async function setSharedRoot(folderId) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(folderId || '')) throw new Error('ID الفولدر غير صحيح');
  const account = await getDriveAccount();
  if (!account) throw new Error('اربط حساب Google في الإكستنشن الأول');

  const res = await authedFetch(`${API}/files/${folderId}?fields=id,name,mimeType,trashed,capabilities/canAddChildren&supportsAllDrives=true`);
  if (isAccessError(res.status)) {
    throw new Error(`مش قادر أوصل للفولدر ده بالحساب المربوط في الإكستنشن (${account.email}). اختار بنفس الحساب ده.`);
  }
  if (!res.ok) throw new Error(`تعذر التأكد من الفولدر (${res.status})`);
  const folder = await res.json();
  if (folder.mimeType !== FOLDER_MIME || folder.trashed) throw new Error('اللي اخترته مش فولدر. اختار فولدر الأكاديمية.');
  if (!folder.capabilities?.canAddChildren) {
    throw new Error('الفولدر ده مش مسموحلك تضيف فيه، اطلب من الأدمن صلاحية Editor');
  }

  await patchAuth({ sharedRootId: folder.id, sharedRootName: folder.name || '', trainerFolderId: '', sharedFolderWarning: '' });
  return { id: folder.id, name: folder.name || '' };
}

export async function clearSharedRoot() {
  await patchAuth({ sharedRootId: '', sharedRootName: '', trainerFolderId: '', sharedFolderWarning: '' });
}

class SharedFolderUnavailableError extends Error {}

function isAccessError(status) {
  return status === 403 || status === 404;
}

function escapeQuery(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function patchAuth(patch) {
  const { [AUTH_KEY]: latest } = await chrome.storage.local.get(AUTH_KEY);
  if (!latest) return;
  await chrome.storage.local.set({ [AUTH_KEY]: { ...latest, ...patch } });
}

export async function createUploadSession({ name, mimeType, description }) {
  const folderId = await ensureFolder();
  const res = await authedFetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id,webViewLink&supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
    body: JSON.stringify({ name, mimeType, description, parents: [folderId] }),
  });
  if (!res.ok) throw new Error(`تعذر بدء الرفع على Drive (${res.status})`);
  return res.headers.get('Location');
}

// بيرفع قطعة. total = null معناها لسه منعرفش الحجم النهائي (التسجيل شغال).
// بيرجع { uploaded } لو لسه فيه باقي، أو { file } لو الملف اكتمل.
export async function uploadChunk(sessionUri, { start, data, total }) {
  const end = start + data.byteLength - 1;
  const range = data.byteLength ? `bytes ${start}-${end}/${total ?? '*'}` : `bytes */${total ?? '*'}`;
  const res = await authedFetch(sessionUri, { method: 'PUT', headers: { 'Content-Range': range }, body: data });
  return parseUploadResponse(res);
}

export async function queryUploadStatus(sessionUri, total = null) {
  const res = await authedFetch(sessionUri, { method: 'PUT', headers: { 'Content-Range': `bytes */${total ?? '*'}` } });
  return parseUploadResponse(res);
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
