// اختيار الجروب والمحاضرة (في الـ popup قبل التسجيل، وفي لوحة التسجيل بعده).
// بيخمّن المحاضرة من لينك Google Meet المفتوح، والمدرب يأكد أو يغيّر.

import { listGroups, listSessions, detectLecture, SystemAuthError } from './system.js';

export function lectureLabel(lecture) {
  if (!lecture) return '';
  const group = lecture.batchCode || lecture.groupName || 'جروب';
  const part = lecture.part > 1 ? ` • جزء ${lecture.part}` : '';
  return `${lecture.courseName ? `${lecture.courseName} • ` : ''}${group} • محاضرة ${lecture.sessionNumber}${part}`;
}

export function createLecturePicker(container, { onChange = () => {} } = {}) {
  container.innerHTML = `
    <div class="notice notice-info" data-status>بيدوّر على المحاضرة...</div>
    <label class="small muted" style="display:block;margin-top:8px">الجروب</label>
    <select data-group aria-label="الجروب"></select>
    <label class="small muted" style="display:block;margin-top:8px">المحاضرة</label>
    <select data-session aria-label="المحاضرة"></select>
    <div class="notice notice-info hidden" data-part style="margin-top:8px"></div>`;
  const statusEl = container.querySelector('[data-status]');
  const groupSel = container.querySelector('[data-group]');
  const sessionSel = container.querySelector('[data-session]');
  const partEl = container.querySelector('[data-part]');
  let groups = [];
  let sessions = [];
  let detected = null;

  const setStatus = (kind, text) => {
    statusEl.className = `notice notice-${kind}`;
    statusEl.textContent = text;
    statusEl.classList.toggle('hidden', !text);
  };

  const value = () => {
    const group = groups.find((g) => g.id === groupSel.value);
    const session = sessions.find((s) => s.id === sessionSel.value);
    if (!group || !session) return null;
    return {
      groupId: group.id,
      groupName: group.name,
      batchCode: group.batchCode,
      courseName: group.courseName,
      sessionId: session.id,
      sessionNumber: session.sessionNumber,
      sessionDate: session.date,
      part: (session.myParts || 0) + 1,
    };
  };

  // لو المدرب سجّل للمحاضرة دي قبل كده (التسجيل اتقفل بالغلط مثلًا)، التسجيل الجديد بيترفع كجزء بعده
  const showPart = () => {
    const session = sessions.find((s) => s.id === sessionSel.value);
    const parts = session?.myParts || 0;
    partEl.classList.toggle('hidden', !parts);
    partEl.textContent = parts ? `سجّلت للمحاضرة دي قبل كده، فالتسجيل ده هيترفع كـ "جزء ${parts + 1}" في نفس فولدرها.` : '';
  };

  const changed = () => {
    showPart();
    const v = value();
    if (detected && v && v.sessionId !== detected.sessionId) setStatus('warn', 'غيّرت المحاضرة عن اللي اتعرفت لوحدها. اتأكد إنها الصح.');
    onChange(v);
  };

  async function loadSessions(groupId, selectId) {
    sessionSel.innerHTML = '<option value="">...</option>';
    sessions = groupId ? await listSessions(groupId) : [];
    sessionSel.innerHTML = '<option value="">اختار المحاضرة</option>' + sessions.map((s) =>
      `<option value="${s.id}">محاضرة ${s.sessionNumber}${s.date ? ` • ${s.date}` : ''}${s.status === 'done' ? ' ✓' : ''}</option>`).join('');
    if (selectId && sessions.some((s) => s.id === selectId)) sessionSel.value = selectId;
  }

  groupSel.addEventListener('change', async () => {
    try {
      await loadSessions(groupSel.value);
    } catch (err) {
      setStatus('danger', err.message);
    }
    changed();
  });
  sessionSel.addEventListener('change', changed);

  // initial: محاضرة محفوظة قبل كده (زي تسجيل بنكمّله). meetUrl: لينك التاب علشان نخمّن منه
  async function load({ initial = null, meetUrl = '' } = {}) {
    try {
      const [allGroups, match] = await Promise.all([
        listGroups(),
        initial ? Promise.resolve(null) : detectLecture(meetUrl).catch(() => null),
      ]);
      groups = allGroups;
      const mine = groups.filter((g) => g.mine);
      const others = groups.filter((g) => !g.mine);
      const opt = (g) => `<option value="${g.id}">${escapeHtml(g.batchCode || g.name)}${g.courseName ? ` — ${escapeHtml(g.courseName)}` : ''}</option>`;
      groupSel.innerHTML = '<option value="">اختار الجروب</option>'
        + (mine.length ? `<optgroup label="جروباتي">${mine.map(opt).join('')}</optgroup>` : '')
        + (others.length ? `<optgroup label="جروبات تانية">${others.map(opt).join('')}</optgroup>` : '');

      const pick = initial || (match && { groupId: match.group.id, sessionId: match.session.id });
      if (pick && groups.some((g) => g.id === pick.groupId)) {
        groupSel.value = pick.groupId;
        await loadSessions(pick.groupId, pick.sessionId);
      } else {
        await loadSessions('');
      }

      if (initial) setStatus('', '');
      else if (match) {
        detected = { sessionId: match.session.id };
        setStatus(match.confident ? 'ok' : 'warn', match.confident
          ? `✓ لقيت المحاضرة${match.by === 'meet' ? ' من لينك الميتينج' : ' من جدولك النهارده'}. اتأكد إنها الصح.`
          : 'ده أقرب اختيار لقيته. اتأكد إنها المحاضرة الصح أو غيّرها.');
      } else setStatus('warn', 'معرفتش المحاضرة لوحدي. اختار الجروب والمحاضرة.');
    } catch (err) {
      setStatus('danger', err instanceof SystemAuthError ? err.message : `تعذر تحميل الجروبات: ${err.message}`);
    }
    showPart();
    onChange(value());
  }

  return { load, value };
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
