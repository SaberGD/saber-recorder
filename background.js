import { getToken, disconnectDrive } from './lib/drive.js';
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

  // نافذة ربط جوجل بتقفل الـ popup، فالربط بيتعمل هنا في الخلفية
  async 'drive-connect'() {
    await getToken({ interactive: true });
    return {};
  },

  async 'drive-disconnect'() {
    await disconnectDrive();
    return {};
  },
};

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
