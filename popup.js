import { CONFIG, QUALITY_PRESETS, DEFAULT_OPTIONS } from './config.js';
import { isDriveConfigured, getDriveAccount } from './lib/drive.js';
import {
  listRecordings, removeRecording, needsAttention, getActiveRecorder, formatBytes, formatDuration,
} from './lib/recordings.js';
import { renderIcons } from './lib/icons.js';

const $ = (id) => document.getElementById(id);
const SOURCES = ['screen', 'systemAudio', 'mic'];

let sourceTab = null;
let driveAccount = null;

init();

async function init() {
  renderIcons();
  renderQualityOptions();
  $('local-hint').textContent = `في فولدر Downloads/${CONFIG.LOCAL_FOLDER_NAME}`;

  const active = await getActiveRecorder();
  if (active) await showActive(active);

  await loadOptions();
  await detectSourceTab();
  await renderDriveAccount();
  await renderRecordings(active?.recId);

  for (const s of SOURCES) $(`src-${s}`).addEventListener('change', syncSourceRows);
  $('btn-start').addEventListener('click', start);
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.driveAuth) renderDriveAccount();
    if (changes.recordings) renderRecordings(active?.recId);
  });
}

function renderQualityOptions() {
  $('quality').innerHTML = Object.entries(QUALITY_PRESETS).map(([key, q]) => `
    <label>
      <input type="radio" name="quality" value="${key}">
      <span class="q-label">${q.label}</span>
      <span class="q-hint">${q.hint}</span>
    </label>`).join('');
}

async function loadOptions() {
  const { lastOptions } = await chrome.storage.local.get('lastOptions');
  const opts = {
    ...DEFAULT_OPTIONS,
    ...lastOptions,
    sources: { ...DEFAULT_OPTIONS.sources, ...lastOptions?.sources },
    save: { ...DEFAULT_OPTIONS.save, ...lastOptions?.save },
  };
  for (const s of SOURCES) $(`src-${s}`).checked = opts.sources[s];
  $('save-local').checked = opts.save.local;
  $('save-drive').checked = opts.save.drive && isDriveConfigured();
  const quality = document.querySelector(`input[name="quality"][value="${opts.quality}"]`)
    || document.querySelector('input[name="quality"][value="balanced"]');
  quality.checked = true;
  syncSourceRows();
}

function syncSourceRows() {
  for (const row of document.querySelectorAll('.source-row')) {
    row.classList.toggle('off', !$(`src-${row.dataset.source}`).checked);
  }
}

async function detectSourceTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const notice = $('tab-notice');
  const isWeb = tab?.url && /^https?:/.test(tab.url);
  const isMeet = isWeb && new URL(tab.url).hostname === 'meet.google.com' && /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(tab.url);

  sourceTab = isWeb ? tab : null;
  if (isMeet) {
    notice.className = 'notice notice-ok';
    notice.textContent = '✓ ميتينج Google Meet مفتوح — صوت الطلبة هيتسجّل من الميتينج نفسه.';
  } else if (isWeb) {
    notice.className = 'notice notice-info';
    notice.textContent = 'لو الميتينج في تاب تانية، افتح الإكستنشن وانت واقف على تاب الميتينج علشان صوت الطلبة يتسجّل مضمون.';
  } else {
    notice.className = 'notice notice-warn';
    notice.textContent = 'افتح الإكستنشن من تاب الميتينج علشان صوت الطلبة يتسجّل مضمون.';
  }

  const date = new Date().toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
  const tabTitle = (tab?.title || '').replace(/^Meet\s*[-–—:]\s*/i, '').trim();
  const looksLikeCode = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(tabTitle) || /google meet/i.test(tabTitle);
  $('title').value = isMeet && tabTitle && !looksLikeCode ? `${tabTitle} — ${date}` : `محاضرة ${date}`;
}

async function renderDriveAccount() {
  const el = $('drive-account');
  const driveBox = $('save-drive');
  if (!isDriveConfigured()) {
    // نسخة الحفظ على الجهاز بس: منعرضش خيار Drive خالص، والحفظ المحلي بيبقى إجباري
    driveBox.checked = false;
    driveBox.closest('label').classList.add('hidden');
    el.classList.add('hidden');
    $('save-local').checked = true;
    $('save-local').disabled = true;
    return;
  }
  driveAccount = await getDriveAccount();
  if (driveAccount) {
    const shared = driveAccount.sharedRootId;
    const notices = [];
    if (driveAccount.sharedFolderWarning) {
      notices.push(`<div class="notice notice-warn" style="margin-top:6px">${escapeHtml(driveAccount.sharedFolderWarning)}</div>`);
    } else if (CONFIG.SHARED_FOLDER_ID && !shared) {
      notices.push('<div class="notice notice-info" style="margin-top:6px">الأكاديمية عاملة فولدر مشترك للتسجيلات. اختاره علشان تسجيلاتك تتجمع فيه.</div>');
    }
    el.innerHTML = `
      <div class="row"><span class="pill pill-ok">✓</span><span class="small grow ltr" style="text-align:right">${escapeHtml(driveAccount.email)}</span>
        <button class="btn btn-link" id="btn-drive-change">تغيير الحساب</button></div>
      <div class="row" style="margin-top:4px">
        <span class="muted small">مكان الرفع:</span>
        <span class="small bold grow">${shared ? escapeHtml(driveAccount.sharedRootName || 'فولدر الأكاديمية') : 'Drive الشخصي'}</span>
        <button class="btn btn-link" id="btn-pick-folder">${shared ? 'تغيير الفولدر' : 'اختار فولدر الأكاديمية'}</button>
      </div>
      ${notices.join('')}`;
    $('btn-drive-change').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'drive-disconnect' });
      connectDrive();
    });
    $('btn-pick-folder').addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'pick-shared-folder' });
      if (res?.ok) window.close();
    });
  } else {
    el.innerHTML = '<button class="btn btn-link" id="btn-drive-connect" style="padding-inline:0">ربط حساب Google ←</button>';
    $('btn-drive-connect').addEventListener('click', connectDrive);
  }
}

function connectDrive() {
  // الـ popup هيتقفل لما نافذة جوجل تفتح، والربط بيكمل في الخلفية
  chrome.runtime.sendMessage({ type: 'drive-connect' });
}

function readOptions() {
  return {
    title: $('title').value.trim() || $('title').placeholder,
    sources: Object.fromEntries(SOURCES.map((s) => [s, $(`src-${s}`).checked])),
    save: { local: $('save-local').checked, drive: $('save-drive').checked },
    quality: document.querySelector('input[name="quality"]:checked').value,
  };
}

async function start() {
  const options = readOptions();
  const error = validate(options);
  $('start-error').classList.toggle('hidden', !error);
  $('start-error').textContent = error || '';
  if (error) return;

  const { lastOptions } = await chrome.storage.local.get('lastOptions');
  await chrome.storage.local.set({ lastOptions: { ...lastOptions, ...options, title: '' } });

  const res = await chrome.runtime.sendMessage({ type: 'open-recorder', options, sourceTabId: sourceTab?.id ?? null });
  if (!res?.ok) {
    $('start-error').classList.remove('hidden');
    $('start-error').textContent = res?.error || 'حصل خطأ';
    return;
  }
  window.close();
}

function validate(options) {
  if (!options.sources.screen && !options.sources.systemAudio && !options.sources.mic) {
    return 'لازم تختار حاجة واحدة على الأقل تتسجّل.';
  }
  if (!options.save.local && !options.save.drive) {
    return 'اختار مكان الحفظ: على الجهاز أو Google Drive أو الاتنين.';
  }
  if (options.save.drive && !driveAccount) {
    return 'اربط حساب Google الأول، أو شيل علامة الرفع على Drive.';
  }
  return '';
}

async function showActive(active) {
  $('active-view').classList.remove('hidden');
  $('setup-view').classList.add('hidden');
  $('btn-focus').addEventListener('click', async () => {
    await chrome.windows.update(active.windowId, { focused: true, state: 'normal' });
    window.close();
  });
  $('btn-stop').addEventListener('click', async () => {
    $('btn-stop').disabled = true;
    await chrome.runtime.sendMessage({ type: 'recorder-stop' });
  });

  const refresh = async () => {
    const status = await chrome.runtime.sendMessage({ type: 'recorder-status' }).catch(() => null);
    if (!status) return;
    $('active-timer').textContent = formatDuration(status.elapsedMs || 0);
    $('active-title').textContent = status.title || '';
    const labels = { ready: 'مستني تختار الشاشة', recording: 'جاري التسجيل', paused: 'متوقف مؤقتًا', finishing: 'بيحفظ ويرفع', done: 'خلص' };
    $('active-label').textContent = labels[status.state] || '';
    $('active-pill').className = `pill ${status.state === 'recording' ? 'pill-rec' : 'pill-warn'}`;
    $('btn-stop').classList.toggle('hidden', !['recording', 'paused'].includes(status.state));
  };
  await refresh();
  setInterval(refresh, 1000);
}

async function renderRecordings(activeRecId) {
  const all = await listRecordings();
  const attention = all.filter((r) => needsAttention(r, activeRecId));
  const recent = all.filter((r) => r.status === 'done').slice(0, 3);

  $('attention').classList.toggle('hidden', !attention.length);
  $('attention-list').innerHTML = attention.map((r) => `
    <div class="list-item">
      <div class="grow">
        <div class="bold">${escapeHtml(r.title)}</div>
        <div class="muted">${statusText(r)} • ${formatBytes(r.bytes)}</div>
      </div>
      <div class="list-actions">
        <button class="btn btn-link" data-resume="${r.id}">استكمال</button>
        <button class="btn btn-link" data-delete="${r.id}" style="color:var(--danger)">حذف</button>
      </div>
    </div>`).join('');

  $('recent').classList.toggle('hidden', !recent.length);
  $('recent-list').innerHTML = recent.map((r) => `
    <div class="list-item">
      <div class="grow">
        <div class="bold">${escapeHtml(r.title)}</div>
        <div class="muted">${new Date(r.createdAt).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })} • ${formatDuration(r.durationMs)} • ${formatBytes(r.bytes)}</div>
      </div>
      ${r.drive?.webViewLink ? `<a class="btn btn-link" href="${escapeHtml(r.drive.webViewLink)}" target="_blank">Drive</a>` : ''}
    </div>`).join('');

  for (const btn of document.querySelectorAll('[data-resume]')) {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'open-recorder', recId: btn.dataset.resume });
      window.close();
    });
  }
  for (const btn of document.querySelectorAll('[data-delete]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('هيتمسح التسجيل ده من الجهاز نهائيًا (النسخة اللي على Drive لو موجودة مش هتتمسح). متأكد؟')) return;
      await removeRecording(btn.dataset.delete);
    });
  }
}

function statusText(rec) {
  if (rec.status === 'failed') return rec.error || 'حصل خطأ';
  if (rec.status === 'finishing') return 'لسه ماخلصش حفظ أو رفع';
  return 'اتقطع أثناء التسجيل — اللي اتسجّل محفوظ';
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
