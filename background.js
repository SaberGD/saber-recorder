import { CONFIG } from './config.js';
import { saveSystemLink, unlinkSystem } from './lib/system.js';
import { listRecordings, patchRecording, getActiveRecorder } from './lib/recordings.js';

const RECORDER_SIZE = { width: 440, height: 720 };

const BADGES = {
  recording: { text: 'REC', color: '#dc2626' },
  paused: { text: 'II', color: '#f59e0b' },
  finishing: { text: '↑', color: '#ff8a1f' },
  idle: { text: '', color: '#000000' },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

const handlers = {
  // من الـ popup: افتح لوحة التسجيل لتسجيل جديد أو لاستكمال تسجيل قديم
  async 'open-recorder'({ options, sourceTabId, recId }) {
    const active = await getActiveRecorder();
    if (active) {
      await chrome.windows.update(active.windowId, { focused: true, state: 'normal' });
      return { reused: true };
    }
    if (options) await chrome.storage.session.set({ pendingStart: { options, sourceTabId: sourceTabId ?? null } });

    const params = new URLSearchParams(recId ? { resume: recId } : { start: '1' });
    const win = await chrome.windows.create({
      url: `recorder.html?${params}`,
      type: 'popup',
      focused: true,
      ...RECORDER_SIZE,
    });
    await chrome.storage.local.set({ activeRecorder: { windowId: win.id, tabId: win.tabs?.[0]?.id, recId: recId || '' } });
    return {};
  },

  async 'set-state'({ state }) {
    const badge = BADGES[state] || BADGES.idle;
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    return {};
  },

  // ربط الإكستنشن بحساب المدرب على السيستم: صفحة على دومين السيستم بيسجّل فيها دخول ويوافق
  async 'link-system'() {
    const params = new URLSearchParams({ ext: chrome.runtime.id });
    const win = await chrome.windows.create({ url: `${CONFIG.LINK_PAGE_URL}?${params}`, type: 'popup', width: 520, height: 640 });
    await chrome.storage.session.set({ linkWindowId: win.id, linkPageReady: false });
    setTimeout(() => checkLinkPageLoaded(win.id), LINK_READY_TIMEOUT_MS);
    return {};
  },

  async 'unlink-system'() {
    await unlinkSystem();
    return {};
  },
};

const LINK_READY_TIMEOUT_MS = 15_000;

// لو صفحة الربط مبعتتش إنها اتفتحت، يبقى السيستم لسه معلهوش deploy للصفحة (بيفتح الصفحة الرئيسية بدالها)
async function checkLinkPageLoaded(windowId) {
  const { linkWindowId, linkPageReady } = await chrome.storage.session.get(['linkWindowId', 'linkPageReady']);
  if (linkPageReady || linkWindowId !== windowId) return;
  await chrome.windows.remove(windowId).catch(() => {});
  chrome.notifications.create('link-unavailable', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'صفحة الربط مش متاحة',
    message: 'صفحة ربط الإكستنشن لسه مش موجودة على السيستم أو مفتحتش. التسجيل والحفظ على الجهاز شغالين عادي. كلّم الأدمن.',
  });
}

// الرسايل اللي بنقبلها من برّه: من صفحة الربط على دومين السيستم بس
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== CONFIG.SYSTEM_ORIGIN) {
    sendResponse({ ok: false, error: 'رسالة غير مسموح بيها' });
    return false;
  }
  if (message?.type === 'link-page-ready') {
    chrome.storage.session.set({ linkPageReady: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type !== 'recorder-linked') {
    sendResponse({ ok: false, error: 'رسالة غير مسموح بيها' });
    return false;
  }
  saveSystemLink(message)
    .then(async () => {
      sendResponse({ ok: true });
      const { linkWindowId } = await chrome.storage.session.get('linkWindowId');
      // نسيب المدرب يشوف رسالة النجاح ثانية ونص وبعدين نقفل النافذة
      if (linkWindowId) setTimeout(() => chrome.windows.remove(linkWindowId).catch(() => {}), 1500);
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

// لو لوحة التسجيل اتقفلت والتسجيل شغال، نعلّمه "اتقطع" علشان يظهر في الـ popup ويتكمل
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { activeRecorder } = await chrome.storage.local.get('activeRecorder');
  if (activeRecorder?.windowId !== windowId) return;
  await chrome.storage.local.remove('activeRecorder');
  await handlers['set-state']({ state: 'idle' });
  await markInterrupted();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.remove('activeRecorder');
  await handlers['set-state']({ state: 'idle' });
  await markInterrupted();
});

async function markInterrupted() {
  const recordings = await listRecordings();
  for (const rec of recordings) {
    if (rec.status === 'recording') {
      await patchRecording(rec.id, { status: 'interrupted' });
      chrome.notifications.create(`interrupted-${rec.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'التسجيل اتقطع',
        message: `"${rec.title}" — اللي اتسجل محفوظ. افتح الإكستنشن علشان تحفظه أو ترفعه.`,
      });
    }
  }
}
