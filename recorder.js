import { CONFIG, QUALITY_PRESETS, DEFAULT_OPTIONS } from './config.js';
import { completeUpload } from './lib/system.js';
import { createLecturePicker, lectureLabel } from './lib/lecture-picker.js';
import {
  getRecording, saveRecording, patchRecording, deleteLocalTemp, formatBytes, formatDuration,
} from './lib/recordings.js';
import { LocalRecordingFile } from './lib/local-file.js';
import { DriveUploader } from './lib/uploader.js';
import { ICONS, renderIcons } from './lib/icons.js';
import { withWebmDuration } from './lib/webm-duration.js';

const $ = (id) => document.getElementById(id);

const SOURCE_INFO = {
  screen: { icon: 'screen', label: 'الشاشة' },
  systemAudio: { icon: 'speaker', label: 'صوت الجهاز والميتينج' },
  mic: { icon: 'mic', label: 'المايك' },
};

const MIC_SILENCE_WARNING_MS = 30_000;
const PERSIST_EVERY_MS = 10_000;

const session = {
  state: 'idle', // idle | ready | recording | paused | finishing | done
  options: null,
  sourceTabId: null,
  rec: null,
  file: null,
  uploader: null,
  recorder: null,
  streams: [],
  audio: null, // { ctx, channels: { mic, systemAudio } }
  videoTrack: null,
  enabled: { screen: true, systemAudio: true, mic: true },
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  writeChain: Promise.resolve(),
  lastPersist: 0,
  warnings: new Map(),
  local: { state: 'idle', error: '', downloadId: null },
  previewMic: null,
};

init();

async function init() {
  renderIcons();
  wireMessages();
  watchSystemLink();
  window.addEventListener('beforeunload', (e) => {
    if (['recording', 'paused', 'finishing'].includes(session.state)) e.preventDefault();
  });
  $('btn-minimize').addEventListener('click', async () => {
    const win = await chrome.windows.getCurrent();
    chrome.windows.update(win.id, { state: 'minimized' });
  });

  const params = new URLSearchParams(location.search);
  if (params.get('resume')) return resume(params.get('resume'));

  const { pendingStart } = await chrome.storage.session.get('pendingStart');
  if (!pendingStart) {
    showView('finish');
    setFinish('alert', 'مفيش تسجيل جديد', 'افتح الإكستنشن من تاب الميتينج واضغط "ابدأ التسجيل".');
    setFinishActions([closeButton()]);
    return;
  }
  await chrome.storage.session.remove('pendingStart');
  session.options = {
    ...DEFAULT_OPTIONS,
    ...pendingStart.options,
    sources: { ...DEFAULT_OPTIONS.sources, ...pendingStart.options.sources },
    save: { ...DEFAULT_OPTIONS.save, ...pendingStart.options.save },
  };
  session.sourceTabId = pendingStart.sourceTabId;
  session.enabled = { ...session.options.sources };
  showReady();
}

/* ---------- قبل البدء ---------- */

function showReady() {
  session.state = 'ready';
  showView('ready');
  $('header-title').textContent = session.options.title;

  renderSourceRows($('ready-sources'), (key, on) => {
    session.enabled[key] = on;
    if (key === 'mic') toggleMicPreview(on);
    $('screen-tip').classList.toggle('hidden', !session.enabled.screen && !session.enabled.systemAudio);
  });

  const save = session.options.save;
  $('ready-save').innerHTML = [
    save.local && `<div class="row"><span class="pill pill-ok">✓</span> حفظ نسخة على الجهاز في Downloads/${CONFIG.LOCAL_FOLDER_NAME}</div>`,
    save.drive && `<div class="row"><span class="pill pill-ok">✓</span> رفع تلقائي على Drive الأكاديمية أثناء التسجيل</div>
      <div class="muted" style="margin-top:4px; margin-inline-start:34px">المحاضرة: <b>${escapeHtml(lectureLabel(session.options.lecture))}</b></div>`,
  ].filter(Boolean).join('');

  $('btn-begin').addEventListener('click', begin);
  if (session.enabled.mic) toggleMicPreview(true);
}

// بنفتح المايك من الأول علشان المدرب يختار المايك الصح ويتأكد إنه شغال قبل ما يبدأ
async function toggleMicPreview(on) {
  $('mic-select-card').classList.toggle('hidden', !on);
  if (!on) return stopPreviewMic();
  try {
    await openPreviewMic(session.options.micDeviceId);
    await fillMicDevices();
  } catch (err) {
    showReadyError(micErrorText(err));
  }
}

async function openPreviewMic(deviceId) {
  stopPreviewMic();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) });
  const ctx = new AudioContext();
  document.addEventListener('pointerdown', () => ctx.resume(), { once: true });
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const timer = setInterval(() => { $('ready-mic-meter').style.width = `${levelPercent(analyser)}%`; }, 100);
  session.previewMic = { stream, ctx, timer };
}

function stopPreviewMic() {
  const p = session.previewMic;
  if (!p) return;
  clearInterval(p.timer);
  p.stream.getTracks().forEach((t) => t.stop());
  p.ctx.close();
  session.previewMic = null;
}

async function fillMicDevices() {
  const select = $('mic-select');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const current = session.previewMic?.stream.getAudioTracks()[0]?.getSettings().deviceId;
  select.innerHTML = devices.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `مايك ${i + 1}`)}</option>`).join('');
  if (current) select.value = current;
  select.onchange = async () => {
    session.options.micDeviceId = select.value;
    const { lastOptions } = await chrome.storage.local.get('lastOptions');
    chrome.storage.local.set({ lastOptions: { ...lastOptions, micDeviceId: select.value } });
    openPreviewMic(select.value).catch((err) => showReadyError(micErrorText(err)));
  };
}

function showReadyError(text) {
  $('ready-error').classList.toggle('hidden', !text);
  $('ready-error').textContent = text || '';
}

/* ---------- بدء التسجيل ---------- */

async function begin() {
  showReadyError('');
  const { enabled } = session;
  if (!enabled.screen && !enabled.systemAudio && !enabled.mic) {
    return showReadyError('لازم تسيب حاجة واحدة على الأقل تتسجّل.');
  }
  $('btn-begin').disabled = true;

  // لازم الـ AudioContext يتعمل جوه الضغطة نفسها، قبل نافذة اختيار الشاشة، وإلا كروم ممكن يسيبه واقف ويطلع التسجيل من غير صوت
  session.audioCtx = new AudioContext({ sampleRate: 48000 });
  session.audioCtx.resume();

  try {
    await captureSources();
  } catch (err) {
    stopAllStreams();
    $('btn-begin').disabled = false;
    return showReadyError(err.message);
  }

  stopPreviewMic();
  await startRecorder();
}

async function captureSources() {
  const { enabled } = session;
  const quality = QUALITY_PRESETS[session.options.quality] || QUALITY_PRESETS.balanced;
  const audioInputs = {};

  // 1) الشاشة (وصوت النظام معاها). لازم ده الأول علشان نافذة الاختيار محتاجة ضغطة المستخدم.
  if (enabled.screen || enabled.systemAudio) {
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          width: { max: quality.width },
          height: { max: quality.height },
          frameRate: { ideal: quality.fps, max: quality.fps },
        },
        audio: enabled.systemAudio
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }
          : false,
        systemAudio: enabled.systemAudio ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') throw new Error('اتلغى اختيار الشاشة. اضغط تاني واختار الشاشة اللي هتسجّلها.');
      throw new Error(`تعذر تسجيل الشاشة: ${err.message}`);
    }
    session.streams.push(display);

    const video = display.getVideoTracks()[0];
    if (enabled.screen) {
      video.contentHint = 'detail'; // شرح وكلام على الشاشة: الأولوية لوضوح الكلام مش الحركة
      video.addEventListener('ended', () => {
        if (session.state === 'recording' || session.state === 'paused') {
          notify('التسجيل خلص', 'مشاركة الشاشة اتقفلت، فالتسجيل اتنهى واتحفظ.');
          stop();
        }
      });
      session.videoTrack = video;
    } else {
      video.stop();
    }

    const sysTrack = display.getAudioTracks()[0];
    if (sysTrack) audioInputs.systemAudio = { stream: new MediaStream([sysTrack]), playback: false };
  }

  // 2) لو صوت النظام مش متاح (ماك، أو اختار نافذة مش الشاشة كلها) ناخد صوت تاب الميتينج مباشرة
  if (enabled.systemAudio && !audioInputs.systemAudio && session.sourceTabId) {
    try {
      const me = await chrome.tabs.getCurrent();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: session.sourceTabId, consumerTabId: me.id });
      const tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false,
      });
      session.streams.push(tabStream);
      // كروم بيكتم صوت التاب لما نسجّله، فلازم نشغّله تاني علشان المدرب يسمع الطلبة
      audioInputs.systemAudio = { stream: tabStream, playback: true, fromTab: true };
    } catch (err) {
      console.warn('tab audio capture failed', err);
    }
  }
  if (enabled.systemAudio && !audioInputs.systemAudio) {
    setWarning('no-system-audio', 'warn', 'صوت الطلبة مش بيتسجّل: ابدأ من جديد واختار "الشاشة بالكامل" مع "مشاركة صوت النظام"، أو افتح الإكستنشن من تاب الميتينج.');
  }

  // 3) المايك
  if (enabled.mic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(session.options.micDeviceId) });
      session.streams.push(mic);
      audioInputs.mic = { stream: mic, playback: false };
      mic.getAudioTracks()[0].addEventListener('mute', () => setWarning('mic-muted', 'warn', 'المايك اتقفل من الجهاز.'));
      mic.getAudioTracks()[0].addEventListener('unmute', () => setWarning('mic-muted', null));
    } catch (err) {
      throw new Error(micErrorText(err));
    }
  }

  if (!session.videoTrack && !Object.keys(audioInputs).length) {
    throw new Error('مفيش أي حاجة اتسجّلت. اتأكد من اختيار الشاشة أو المايك.');
  }

  session.audio = mixAudio(audioInputs);
  session.available = { screen: Boolean(session.videoTrack), systemAudio: Boolean(audioInputs.systemAudio), mic: Boolean(audioInputs.mic) };
}

// بنجمع كل الأصوات في تراك واحد، وكل مصدر له gain علشان نكتمه من غير ما نوقف التسجيل
function mixAudio(inputs) {
  const keys = Object.keys(inputs);
  if (!keys.length) return null;
  const ctx = session.audioCtx;
  ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const channels = {};
  for (const key of keys) {
    const source = ctx.createMediaStreamSource(inputs[key].stream);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(gain).connect(dest);
    source.connect(analyser);
    if (inputs[key].playback) source.connect(ctx.destination);
    gain.gain.value = session.enabled[key] ? 1 : 0;
    channels[key] = { gain, analyser, fromTab: Boolean(inputs[key].fromTab), silentSince: Date.now() };
  }
  return { ctx, dest, channels };
}

async function startRecorder() {
  const quality = QUALITY_PRESETS[session.options.quality] || QUALITY_PRESETS.balanced;
  const tracks = [];
  if (session.videoTrack) tracks.push(session.videoTrack);
  if (session.audio) tracks.push(session.audio.dest.stream.getAudioTracks()[0]);
  const stream = new MediaStream(tracks);
  const mimeType = pickMimeType(Boolean(session.videoTrack), Boolean(session.audio));
  const ext = session.videoTrack ? 'webm' : 'weba';

  session.recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: quality.videoBitsPerSecond,
    audioBitsPerSecond: quality.audioBitsPerSecond,
  });

  const now = new Date();
  const id = `rec-${now.getTime()}`;
  const baseName = `${safeFileName(session.options.title)} - ${stamp(now)}.${ext}`;
  session.rec = await saveRecording({
    id,
    title: session.options.title,
    createdAt: now.getTime(),
    fileName: `${id}.${ext}`,
    driveName: baseName,
    localName: `${CONFIG.LOCAL_FOLDER_NAME}/${baseName}`,
    mimeType,
    quality: session.options.quality,
    sources: session.available,
    save: session.options.save,
    lecture: session.options.lecture || null,
    status: 'recording',
    bytes: 0,
    durationMs: 0,
    drive: {},
    local: {},
  });
  const { activeRecorder } = await chrome.storage.local.get('activeRecorder');
  await chrome.storage.local.set({ activeRecorder: { ...activeRecorder, recId: id } });

  session.file = new LocalRecordingFile(session.rec.fileName);
  await session.file.open();
  if (session.options.save.drive) {
    session.uploader = new DriveUploader({ rec: session.rec, file: session.file, onChange: renderSave });
  }

  session.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    session.writeChain = session.writeChain
      .then(() => e.data.arrayBuffer())
      .then((buf) => session.file.append(buf))
      .then(() => {
        session.uploader?.pump();
        persistProgress();
      })
      .catch((err) => setWarning('write', 'danger', `مشكلة في الحفظ على الجهاز: ${err.message}`));
  };
  session.recorder.onerror = (e) => {
    setWarning('recorder', 'danger', `المسجّل وقف: ${e.error?.message || 'خطأ غير معروف'}`);
    stop();
  };

  session.recorder.start(CONFIG.TIMESLICE_MS);
  session.startedAt = Date.now();
  session.state = 'recording';
  setBadge('recording');
  showRecording();

  const recorded = Object.entries(session.available).filter(([k, v]) => v && session.enabled[k]).map(([k]) => SOURCE_INFO[k].label);
  notify('بدأ التسجيل', `بيتسجّل دلوقتي: ${recorded.join('، ')}`);
  watchMeetingEnd();
}

/* ---------- إنهاء أوتوماتيك لما الميتينج يخلص ---------- */

const MEET_CHECK_MS = 5000;
const AUTO_STOP_SECONDS = 20;

// بيشتغل جوه تاب الميتينج: لسه في المكالمة؟ (زرار إنهاء المكالمة موجود)
// null = مش صفحة Google Meet، فمنقدرش نحكم
function meetInCallProbe() {
  if (location.hostname !== 'meet.google.com') return null;
  const byLabel = document.querySelector('[aria-label*="Leave call" i], [aria-label*="مغادرة المكالمة"], [aria-label*="إنهاء المكالمة"], [jsname="CQylAd"]');
  if (byLabel) return true;
  // أيقونة زرار إنهاء المكالمة اسمها call_end في كل اللغات
  return [...document.querySelectorAll('i, span')].some((el) => el.childElementCount === 0 && el.textContent.trim() === 'call_end');
}

function watchMeetingEnd() {
  if (!session.options.autoStop || !session.sourceTabId) return;
  let seenInCall = false;
  let misses = 0;
  session.meetTimer = setInterval(async () => {
    if (!['recording', 'paused'].includes(session.state) || session.autoStopDismissed) return;
    let inCall;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: session.sourceTabId }, func: meetInCallProbe });
      inCall = res?.result;
    } catch {
      // التاب اتقفل أو خرج من صفحة الميتينج
      inCall = seenInCall ? false : null;
    }
    if (inCall === null || inCall === undefined) return;
    if (inCall) {
      seenInCall = true;
      misses = 0;
      return;
    }
    if (!seenInCall) return;
    misses += 1;
    // مرتين ورا بعض (حوالي 10 ثواني) علشان منقفلش بسبب لحظة تحميل
    if (misses >= 2 && !session.autoStopTimer) startAutoStopCountdown();
  }, MEET_CHECK_MS);
}

function startAutoStopCountdown() {
  let left = AUTO_STOP_SECONDS;
  const banner = $('autostop-banner');
  const render = () => { $('autostop-text').textContent = `الميتينج خلص. التسجيل هيتنهي ويتحفظ خلال ${left} ثانية.`; };
  render();
  banner.classList.remove('hidden');
  notify('الميتينج خلص', `التسجيل هيتنهي خلال ${AUTO_STOP_SECONDS} ثانية. لو لسه بتشرح افتح لوحة التسجيل واضغط "كمّل التسجيل".`);
  $('btn-keep-recording').onclick = () => {
    clearInterval(session.autoStopTimer);
    session.autoStopTimer = null;
    session.autoStopDismissed = true; // المدرب قال يكمّل: مش هنسأله تاني في التسجيل ده
    banner.classList.add('hidden');
  };
  session.autoStopTimer = setInterval(() => {
    left -= 1;
    render();
    if (left > 0) return;
    clearInterval(session.autoStopTimer);
    session.autoStopTimer = null;
    banner.classList.add('hidden');
    notify('التسجيل اتنهى', 'الميتينج خلص، فالتسجيل اتنهى وبيتحفظ.');
    stop();
  }, 1000);
}

/* ---------- أثناء التسجيل ---------- */

function showRecording() {
  showView('rec');
  $('btn-minimize').classList.remove('hidden');
  renderSourceRows($('rec-sources'), (key, on) => {
    session.enabled[key] = on;
    if (key === 'screen' && session.videoTrack) session.videoTrack.enabled = on;
    const channel = session.audio?.channels[key];
    if (channel) channel.gain.gain.value = on ? 1 : 0;
    const label = SOURCE_INFO[key].label;
    notify(on ? `${label} رجع يتسجّل` : `${label} اتقفل`, on ? 'بيتسجّل تاني دلوقتي.' : 'مش بيتسجّل لحد ما ترجعه.');
  }, true);

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-stop').addEventListener('click', () => {
    if (confirm('إنهاء التسجيل؟')) stop();
  });

  const quality = QUALITY_PRESETS[session.options.quality] || QUALITY_PRESETS.balanced;
  $('rec-rate').textContent = `${quality.label} • ${quality.hint.split('•')[0].trim()}`;
  renderSave();
  session.tick = setInterval(tick, 250);
}

function tick() {
  const elapsed = elapsedMs();
  $('rec-timer').textContent = formatDuration(elapsed);
  $('rec-size').textContent = formatBytes(session.file?.size || 0);
  document.title = `${session.state === 'paused' ? 'II' : '●'} ${formatDuration(elapsed)} — Saber Recorder`;

  for (const [key, channel] of Object.entries(session.audio?.channels || {})) {
    const level = levelPercent(channel.analyser);
    const meter = document.querySelector(`#rec-sources [data-meter="${key}"]`);
    if (meter) meter.style.width = `${session.enabled[key] ? level : 0}%`;
    if (level > 4) channel.silentSince = Date.now();
  }

  const mic = session.audio?.channels.mic;
  const micSilent = mic && session.enabled.mic && session.state === 'recording'
    && Date.now() - mic.silentSince > MIC_SILENCE_WARNING_MS;
  setWarning('mic-silent', micSilent ? 'warn' : null, 'المايك مش بيلقط أي صوت من 30 ثانية — اتأكد إنه مش Mute أو إنك مختار المايك الصح.');
}

function togglePause() {
  const btn = $('btn-pause');
  if (session.state === 'recording') {
    session.recorder.pause();
    session.pausedAt = Date.now();
    session.state = 'paused';
    btn.innerHTML = `${ICONS.play} <span>استكمال التسجيل</span>`;
    $('rec-label').textContent = 'متوقف مؤقتًا';
    $('rec-pill').className = 'pill pill-warn';
    setBadge('paused');
  } else if (session.state === 'paused') {
    session.recorder.resume();
    session.pausedTotal += Date.now() - session.pausedAt;
    session.state = 'recording';
    btn.innerHTML = `${ICONS.pause} <span>إيقاف مؤقت</span>`;
    $('rec-label').textContent = 'جاري التسجيل';
    $('rec-pill').className = 'pill pill-rec';
    setBadge('recording');
  }
  $('rec-pill').querySelector('.dot')?.classList.toggle('pulse', session.state === 'recording');
}

function elapsedMs() {
  if (!session.startedAt) return 0;
  const end = session.state === 'paused' ? session.pausedAt : (session.stoppedAt || Date.now());
  return end - session.startedAt - session.pausedTotal;
}

async function persistProgress(force = false) {
  if (!force && Date.now() - session.lastPersist < PERSIST_EVERY_MS) return;
  session.lastPersist = Date.now();
  await patchRecording(session.rec.id, { bytes: session.file.size, durationMs: elapsedMs() });
}

/* ---------- الإنهاء والحفظ ---------- */

async function stop() {
  if (session.state !== 'recording' && session.state !== 'paused') return;
  if (session.state === 'paused') session.pausedTotal += Date.now() - session.pausedAt;
  session.stoppedAt = Date.now();
  session.state = 'finishing';
  clearInterval(session.tick);
  clearInterval(session.meetTimer);
  clearInterval(session.autoStopTimer);
  setBadge('finishing');

  await new Promise((resolve) => {
    session.recorder.addEventListener('stop', resolve, { once: true });
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    else resolve();
  });
  await session.writeChain;
  const size = await session.file.close();
  stopAllStreams();

  session.rec = await patchRecording(session.rec.id, { status: 'finishing', bytes: size, durationMs: elapsedMs(), cleanStop: true });
  await finishSaving();
}

async function resume(recId) {
  const rec = await getRecording(recId);
  showView('finish');
  if (!rec) {
    setFinish('alert', 'التسجيل مش موجود', 'ممكن يكون اتمسح.');
    setFinishActions([closeButton()]);
    return;
  }
  $('header-title').textContent = rec.title;
  session.rec = rec;
  session.file = new LocalRecordingFile(rec.fileName);
  const needsFile = (rec.save.local && !rec.local?.done) || (rec.save.drive && !rec.drive?.done);
  if (needsFile && !(await session.file.exists())) {
    await patchRecording(rec.id, { status: 'failed', error: 'الملف المؤقت مش موجود على الجهاز' });
    setFinish('alert', 'الملف مش موجود', 'الملف المؤقت للتسجيل ده اتمسح من الجهاز.');
    setFinishActions([closeButton()]);
    return;
  }
  session.state = 'finishing';
  setBadge('finishing');
  session.rec = await patchRecording(rec.id, { status: 'finishing', bytes: session.file.size, error: '' });
  if (rec.save.drive) session.uploader = new DriveUploader({ rec: session.rec, file: session.file, onChange: renderSave });
  await finishSaving();
}

async function finishSaving() {
  showView('finish');
  $('btn-minimize').classList.add('hidden');
  setFinish('drive', 'بيحفظ التسجيل...', `${durationLabel(session.rec)} • ${formatBytes(session.rec.bytes)}`);
  setFinishActions([]);
  renderSave();

  const tasks = [];
  if (session.rec.save.local && !session.rec.local?.done) tasks.push(saveLocally());
  if (session.uploader) {
    session.uploader.setFinalSize(session.rec.bytes);
    // الرفع بيكمّل في نفس الوقت اللي المدرب بيأكد فيه المحاضرة، وبعد الاتنين بنثبّت الملف في فولدره
    tasks.push(Promise.all([session.uploader.whenDone(), confirmLecture()]).then(([file, lecture]) => finalizeDriveUpload(file, lecture)));
  }
  await Promise.all(tasks);

  await deleteLocalTemp(session.rec.fileName);
  session.rec = await patchRecording(session.rec.id, { status: 'done', error: '' });
  session.state = 'done';
  setBadge('idle');
  document.title = 'Saber Recorder';

  const where = [session.rec.save.local && 'على الجهاز', session.rec.save.drive && 'على Drive الأكاديمية'].filter(Boolean).join(' و');
  notify('التسجيل اتحفظ ✓', `"${session.rec.title}" اتحفظ ${where}.`);
  setFinish('check', 'التسجيل اتحفظ', `${durationLabel(session.rec)} • ${formatBytes(session.rec.bytes)} • ${where}`);
  renderSave();

  const actions = [];
  if (session.local.downloadId) actions.push(button('فتح مكان الملف', () => chrome.downloads.show(session.local.downloadId)));
  const link = session.rec.drive?.webViewLink;
  if (link) actions.push(button('فتح على Drive', () => chrome.tabs.create({ url: link })));
  if (session.rec.lecture) actions.push(button('سجّل جزء تاني لنفس المحاضرة', startNextPart, 'btn grow'));
  actions.push(closeButton());
  setFinishActions(actions);
}

// التسجيل اتقفل بالغلط والمدرب عايز يكمّل: تسجيل جديد لنفس المحاضرة، والسيستم بيرفعه كالجزء اللي بعده
async function startNextPart() {
  const rec = session.rec;
  const base = session.options || {};
  const lecture = { ...rec.lecture, part: (rec.lecture.part || 1) + 1 };
  const options = {
    ...DEFAULT_OPTIONS,
    ...base,
    title: lectureLabel(lecture),
    sources: base.sources || rec.sources || DEFAULT_OPTIONS.sources,
    save: rec.save,
    quality: base.quality || rec.quality || DEFAULT_OPTIONS.quality,
    lecture,
  };
  await chrome.storage.session.set({ pendingStart: { options, sourceTabId: session.sourceTabId ?? null } });
  location.href = 'recorder.html?start=1';
}

async function saveLocally() {
  session.local = { state: 'saving', error: '', downloadId: null };
  renderSave();
  while (true) {
    try {
      const file = await session.file.getFile();
      // المدة بتتضاف بس لو التسجيل خلص طبيعي، لأن مدة التسجيل اللي اتقطع مش مضبوطة بالثانية
      const blob = session.rec.cleanStop ? await withWebmDuration(file, session.rec.durationMs) : file;
      const url = URL.createObjectURL(blob);
      const downloadId = await downloadWithFallbackName(url);
      session.local.downloadId = downloadId;
      await waitForDownload(downloadId);
      URL.revokeObjectURL(url);
      session.local.state = 'done';
      await patchRecording(session.rec.id, { local: { done: true } });
      renderSave();
      return;
    } catch (err) {
      session.local = { state: 'failed', error: err.message, downloadId: null };
      renderSave();
      // نستنى المدرب يدوس "حاول تاني"
      await new Promise((resolve) => { session.local.retry = resolve; });
      session.local = { state: 'saving', error: '', downloadId: null };
      renderSave();
    }
  }
}

// بعض الأجهزة بترفض الأسماء العربي في اسم الملف، فبنجرب اسم إنجليزي بالتاريخ
async function downloadWithFallbackName(url) {
  const download = (filename) => chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  try {
    return await download(session.rec.localName);
  } catch (err) {
    if (!/filename/i.test(err.message)) throw err;
    const ext = session.rec.fileName.split('.').pop();
    return download(`${CONFIG.LOCAL_FOLDER_NAME}/lecture ${stamp(new Date(session.rec.createdAt))}.${ext}`);
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error('الحفظ على الجهاز اتلغى أو فشل'));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // الملفات الصغيرة ممكن تخلص قبل ما نبدأ نسمع، فنشيك على الحالة الحالية كمان
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') listener({ id: downloadId, state: { current: 'complete' } });
      else if (item?.state === 'interrupted') listener({ id: downloadId, state: { current: 'interrupted' } });
    });
  });
}

/* ---------- الواجهة ---------- */

function renderSourceRows(container, onToggle, live = false) {
  const keys = Object.keys(SOURCE_INFO).filter((k) => !live || session.available[k] || session.options.sources[k]);
  container.innerHTML = keys.map((key) => {
    const info = SOURCE_INFO[key];
    const missing = live && !session.available[key];
    const status = live ? liveStatus(key, missing) : readyStatus(key);
    return `
      <div class="row source-row ${session.enabled[key] && !missing ? '' : 'off'}" data-source="${key}">
        <span class="source-icon">${ICONS[info.icon]}</span>
        <div class="grow">
          <div class="bold">${info.label}</div>
          <div class="muted" data-status="${key}">${status}</div>
          ${live && key !== 'screen' && !missing ? `<div class="meter"><div data-meter="${key}"></div></div>` : ''}
        </div>
        <label class="switch"><input type="checkbox" ${session.enabled[key] && !missing ? 'checked' : ''} ${missing ? 'disabled' : ''} aria-label="${info.label}"><span></span></label>
      </div>`;
  }).join('');

  for (const row of container.querySelectorAll('.source-row')) {
    const key = row.dataset.source;
    row.querySelector('input').addEventListener('change', (e) => {
      row.classList.toggle('off', !e.target.checked);
      onToggle(key, e.target.checked);
      const statusEl = row.querySelector(`[data-status="${key}"]`);
      statusEl.textContent = live ? liveStatus(key, false) : readyStatus(key);
    });
  }
}

function readyStatus(key) {
  if (!session.enabled[key]) return 'مش هيتسجّل';
  if (key === 'screen') return 'هتختار الشاشة في الخطوة الجاية';
  if (key === 'systemAudio') return session.sourceTabId ? 'صوت الطلبة وصوت الجهاز' : 'صوت الجهاز (افتح الإكستنشن من تاب الميتينج للضمان)';
  return 'صوتك من المايك';
}

function liveStatus(key, missing) {
  if (missing) return 'مش متاح في التسجيل ده';
  if (!session.enabled[key]) return '⏸ مقفول — مش بيتسجّل';
  if (key === 'systemAudio' && session.audio?.channels.systemAudio?.fromTab) return '● بيتسجّل (صوت تاب الميتينج)';
  if (key === 'screen') return '● بيتسجّل';
  return '● بيتسجّل';
}

function renderSave() {
  const rec = session.rec;
  if (!rec) return;
  const parts = [];

  if (rec.save.local) {
    let text;
    if (session.state === 'recording' || session.state === 'paused') text = 'بيتحفظ على الجهاز أول بأول، والملف هيظهر في Downloads لما تنهي التسجيل';
    else if (session.local.state === 'done' || rec.local?.done) text = `✓ اتحفظ في Downloads/${CONFIG.LOCAL_FOLDER_NAME}`;
    else if (session.local.state === 'failed') text = `✗ ${session.local.error}`;
    else text = 'بيتحفظ في Downloads...';
    parts.push(`<div class="row"><span class="source-icon">${ICONS.laptop}</span><div class="grow"><div class="bold">على الجهاز</div><div class="muted">${text}</div></div>
      ${session.local.state === 'failed' ? '<button class="btn btn-link" data-action="retry-local">حاول تاني</button>' : ''}</div>`);
  }

  const up = session.uploader;
  if (rec.save.drive && up) {
    const total = up.total ?? session.file?.size ?? rec.bytes;
    const pct = up.state === 'done' ? 100 : total ? Math.min(100, Math.round((up.uploaded / total) * 100)) : 0;
    const texts = {
      waiting: session.state === 'recording' || session.state === 'paused' ? 'بيترفع وانت بتسجّل' : 'بيجهّز الرفع...',
      uploading: 'بيرفع...',
      retrying: `⚠ ${up.error} — هيحاول تاني لوحده`,
      'needs-auth': `⚠ ${up.error}`,
      failed: `✗ ${up.error}`,
      done: rec.drive?.completed ? `✓ اترفع في: ${rec.drive.folderPath || up.folderPath}` : '✓ اترفع، مستني تأكيد المحاضرة',
    };
    parts.push(`<div class="row"><span class="source-icon">${ICONS.drive}</span><div class="grow">
        <div class="row" style="margin:0"><span class="bold grow">Drive الأكاديمية</span><span class="muted ltr">${formatBytes(up.uploaded)} / ${formatBytes(total)}</span></div>
        <div class="progress" style="margin-top:6px"><div style="width:${pct}%"></div></div>
        <div class="muted" style="margin-top:4px">${texts[up.state] || ''}</div>
        ${session.completeError ? `<div class="notice notice-danger" style="margin-top:6px">${escapeHtml(session.completeError)}</div>` : ''}
      </div></div>
      ${up.state === 'needs-auth' ? '<button class="btn btn-primary btn-block" data-action="reauth" style="margin-top:8px">ربط الإكستنشن بالسيستم تاني</button>' : ''}
      ${up.state === 'failed' || session.completeError ? '<button class="btn btn-block" data-action="retry-drive" style="margin-top:8px">حاول تاني</button>' : ''}`);
  }

  const html = `<div class="card-title">الحفظ</div>${parts.join('<div style="height:10px"></div>')}`;
  const target = session.state === 'recording' || session.state === 'paused' ? $('rec-save') : $('finish-save');
  target.innerHTML = html;
  target.querySelector('[data-action="retry-local"]')?.addEventListener('click', () => session.local.retry?.());
  target.querySelector('[data-action="reauth"]')?.addEventListener('click', () => {
    // بعد الربط watchSystemLink بيكمّل الرفع لوحده
    chrome.runtime.sendMessage({ type: 'link-system' });
  });
  target.querySelector('[data-action="retry-drive"]')?.addEventListener('click', () => {
    if (session.completeError) session.retryComplete?.();
    else session.uploader.resumeAfterAuth();
  });
}

function setWarning(key, level, text) {
  if (!level) session.warnings.delete(key);
  else session.warnings.set(key, { level, text });
  const box = $('rec-warnings');
  if (!box) return;
  box.innerHTML = [...session.warnings.values()]
    .map((w) => `<div class="notice notice-${w.level}">${ICONS.alert}<span>${escapeHtml(w.text)}</span></div>`).join('');
  for (const svg of box.querySelectorAll('svg')) Object.assign(svg.style, { width: '16px', height: '16px', flex: 'none' });
}

function showView(name) {
  for (const v of ['ready', 'rec', 'finish']) $(`${v}-view`).classList.toggle('hidden', v !== name);
}

function setFinish(icon, heading, sub) {
  $('finish-icon').innerHTML = ICONS[icon] || '';
  $('finish-heading').textContent = heading;
  $('finish-sub').textContent = sub;
}

function setFinishActions(buttons) {
  const box = $('finish-actions');
  box.replaceChildren(...buttons);
}

function button(text, onClick, cls = 'btn grow') {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function closeButton() {
  return button('إغلاق', () => window.close(), 'btn btn-primary grow');
}

/* ---------- مساعدات ---------- */

function wireMessages() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'recorder-status') {
      sendResponse({ state: session.state, elapsedMs: elapsedMs(), title: session.options?.title || session.rec?.title || '' });
    } else if (message?.type === 'recorder-stop') {
      stop();
      sendResponse({ ok: true });
    } else if (message?.type === 'recorder-toggle-pause') {
      togglePause();
      sendResponse({ ok: true, state: session.state });
    }
    return false;
  });
}

// لو الربط بالسيستم اتجدد (المدرب عمل ربط تاني) نكمّل الرفع اللي كان واقف
function watchSystemLink() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.systemAuth?.newValue) return;
    if (session.uploader?.state === 'needs-auth') session.uploader.resumeAfterAuth();
    if (session.completeError) session.retryComplete?.();
  });
}

/* ---------- تأكيد المحاضرة بعد التسجيل ---------- */

// "التسجيل ده لمحاضرة كذا؟" ولو لأ المدرب يختار الصح. بيرجع المحاضرة النهائية.
function confirmLecture() {
  const card = $('finish-lecture');
  const current = session.rec.lecture;
  if (session.rec.drive?.completed) return Promise.resolve(current);
  card.classList.remove('hidden');

  return new Promise((resolve) => {
    const ask = () => {
      card.innerHTML = `
        <div class="card-title">اتأكد من المحاضرة</div>
        <p>التسجيل ده لـ <b>${escapeHtml(lectureLabel(current))}</b>؟</p>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-primary grow" data-yes>أيوه، صح</button>
          <button class="btn grow" data-change>لأ، غيّر</button>
        </div>`;
      card.querySelector('[data-yes]').addEventListener('click', () => done(current));
      card.querySelector('[data-change]').addEventListener('click', change);
    };
    const change = () => {
      card.innerHTML = `<div class="card-title">اختار المحاضرة الصح</div><div data-picker></div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-primary grow" data-save disabled>تأكيد</button>
          <button class="btn grow" data-back>رجوع</button>
        </div>`;
      let picked = null;
      const save = card.querySelector('[data-save]');
      const picker = createLecturePicker(card.querySelector('[data-picker]'), {
        onChange(value) {
          picked = value;
          save.disabled = !value;
        },
      });
      picker.load({ initial: current });
      save.addEventListener('click', () => picked && done(picked));
      card.querySelector('[data-back]').addEventListener('click', ask);
    };
    const done = async (lecture) => {
      card.innerHTML = `<div class="card-title">المحاضرة</div><p>✓ ${escapeHtml(lectureLabel(lecture))}</p>`;
      session.rec = await patchRecording(session.rec.id, { lecture });
      // لو الرفع لسه مفتحش جلسة (أو وقف علشان مكانش فيه محاضرة) يبدأ في الفولدر الصح على طول
      const up = session.uploader;
      if (up && !up.sessionUri) {
        up.rec = session.rec;
        if (up.state === 'failed') up.resumeAfterAuth();
      }
      resolve(lecture);
    };
    // تسجيل قديم ملوش محاضرة محفوظة: نختار على طول
    if (current) ask();
    else change();
  });
}

// بعد الرفع والتأكيد: السيستم بيتأكد من الملف، ولو المحاضرة اتغيرت بينقله لفولدرها الصح
async function finalizeDriveUpload(file, lecture) {
  if (session.rec.drive?.completed) return;
  while (true) {
    try {
      session.completeError = '';
      renderSave();
      const res = await completeUpload(session.rec.drive.recordingId || session.uploader.recordingId, {
        fileId: file.id,
        groupId: lecture.groupId,
        sessionId: lecture.sessionId,
        bytes: session.rec.bytes,
        durationSec: Math.round((session.rec.durationMs || 0) / 1000),
      });
      session.rec = await patchRecording(session.rec.id, {
        // رقم الجزء الحقيقي من السيستم (لو المحاضرة اتغيرت ممكن يتغير)
        lecture: { ...lecture, part: res.part || 1 },
        drive: { completed: true, webViewLink: res.webViewLink || session.rec.drive?.webViewLink || '', folderPath: res.folderPath || '' },
      });
      renderSave();
      return;
    } catch (err) {
      session.completeError = `مقدرتش أثبّت التسجيل في فولدر المحاضرة: ${err.message}`;
      renderSave();
      await new Promise((resolve) => { session.retryComplete = resolve; });
    }
  }
}

function stopAllStreams() {
  for (const s of session.streams) s.getTracks().forEach((t) => t.stop());
  session.streams = [];
  if (session.audioCtx?.state !== 'closed') session.audioCtx?.close();
  session.audio = null;
}

function micConstraints(deviceId) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

function micErrorText(err) {
  if (err?.name === 'NotAllowedError') return 'صلاحية المايك مرفوضة. اضغط على أيقونة القفل/المايك في شريط العنوان واسمح بالمايك، أو اقفل المايك من الاختيارات.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'مفيش مايك متوصل، أو المايك المختار اتشال.';
  return `تعذر تشغيل المايك: ${err?.message || err}`;
}

function levelPercent(analyser) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  const rms = Math.sqrt(sum / data.length);
  return Math.min(100, Math.round(rms * 400));
}

// WebM لأنه بيتكتب أول بأول (MP4 في كروم مبيطلعش غير لما التسجيل يخلص، فلو الجهاز فصل كله يضيع).
// VP9 ضغطه أحسن بكتير للشاشة والكلام.
function pickMimeType(hasVideo, hasAudio) {
  const candidates = hasVideo
    ? ['vp9', 'vp8'].map((v) => `video/webm;codecs=${hasAudio ? `${v},opus` : v}`)
    : ['audio/webm;codecs=opus'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || (hasVideo ? 'video/webm' : 'audio/webm');
}

// مدة التسجيل اللي اتقطع مش مضبوطة (بتتحفظ كل كام ثانية بس)، فمش بنعرضها
function durationLabel(rec) {
  return rec.cleanStop ? formatDuration(rec.durationMs) : 'تسجيل اتقطع';
}

function safeFileName(text) {
  return (text || 'محاضرة').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function stamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function setBadge(state) {
  chrome.runtime.sendMessage({ type: 'set-state', state }).catch(() => {});
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, silent: true });
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
