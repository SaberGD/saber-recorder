// بيرفع التسجيل على Drive الأكاديمية وهو لسه بيتسجل، قطعة قطعة.
// مكان الرفع (sessionUri وعدد البايتات) بيتحفظ، فلو النت فصل أو الكروم اتقفل الرفع بيكمل من مكانه.

import { CONFIG } from '../config.js';
import {
  createUploadSession, uploadChunk, queryUploadStatus,
  SystemAuthError, UploadSessionExpiredError,
} from './system.js';
import { patchRecording } from './recordings.js';

const MAX_BACKOFF_MS = 60_000;

export class DriveUploader {
  static instances = new Set();

  // file: LocalRecordingFile. onChange بيتنادى كل ما الحالة تتغير علشان الواجهة.
  constructor({ rec, file, onChange }) {
    this.rec = rec;
    this.file = file;
    this.onChange = onChange || (() => {});
    this.sessionUri = rec.drive?.sessionUri || '';
    this.recordingId = rec.drive?.recordingId || '';
    this.folderPath = rec.drive?.folderPath || '';
    this.uploaded = rec.drive?.uploaded || 0;
    this.total = null;
    this.needsSync = Boolean(this.sessionUri);
    this.running = false;
    this.backoff = 2000;
    this.retryTimer = null;
    this.state = 'waiting'; // waiting | uploading | retrying | needs-auth | failed | done
    this.error = '';
    this.result = rec.drive?.fileId ? { id: rec.drive.fileId, webViewLink: rec.drive.webViewLink } : null;
    this.donePromise = new Promise((resolve) => { this.resolveDone = resolve; });
    DriveUploader.instances.add(this);
    if (this.result) this.finish(this.result);
  }

  // بننادي عليها لما التسجيل يخلص ونعرف الحجم النهائي
  setFinalSize(total) {
    this.total = total;
    this.pump();
  }

  pump() {
    if (this.state === 'done' || this.state === 'needs-auth' || this.state === 'failed') return;
    if (this.running) {
      // اللفة الحالية ممكن تكون خلاص طالعة، فنلف تاني بعدها علشان منفوّتش داتا جديدة أو الحجم النهائي
      this.pumpAgain = true;
      return;
    }
    clearTimeout(this.retryTimer);
    this.running = true;
    this.pumpAgain = false;
    this.loop()
      .catch((err) => this.handleError(err))
      .finally(() => {
        this.running = false;
        if (this.pumpAgain && this.state !== 'retrying') this.pump();
      });
  }

  async loop() {
    const chunk = CONFIG.UPLOAD_CHUNK_BYTES;

    if (!this.sessionUri) {
      this.setState('uploading');
      // السيستم بيجهّز فولدر المحاضرة على Drive الأكاديمية ويفتح جلسة الرفع فيه
      const session = await createUploadSession(this.rec);
      this.sessionUri = session.uploadUrl;
      this.recordingId = session.recordingId;
      this.folderPath = session.folderPath || '';
      await this.persist();
    }

    if (this.needsSync) {
      const status = await queryUploadStatus(this.sessionUri, this.total);
      if (status.file) return this.finish(status.file);
      this.uploaded = status.uploaded;
      this.needsSync = false;
      await this.persist();
    }

    while (true) {
      const available = this.total ?? this.file.size;
      const remaining = available - this.uploaded;
      const isFinal = this.total !== null;

      if (!isFinal && remaining < chunk) {
        this.setState('waiting');
        return;
      }

      const length = isFinal ? Math.min(remaining, chunk) : chunk;
      const lastPiece = isFinal && length === remaining;
      this.setState('uploading');
      const data = length ? await this.file.read(this.uploaded, length) : new ArrayBuffer(0);
      const res = await uploadChunk(this.sessionUri, {
        start: this.uploaded,
        data,
        total: lastPiece ? this.total : null,
      });

      if (res.file) return this.finish(res.file);
      this.uploaded = res.uploaded;
      this.backoff = 2000;
      await this.persist();
      this.onChange(this);
    }
  }

  handleError(err) {
    if (err instanceof SystemAuthError) {
      this.error = err.message;
      this.setState('needs-auth');
      return;
    }
    if (err.retryable === false) {
      // زي "المحاضرة مش موجودة": إعادة المحاولة لوحدها مش هتفرق، المدرب لازم يتدخل
      this.error = err.message;
      this.setState('failed');
      return;
    }
    if (err instanceof UploadSessionExpiredError) {
      // الجلسة بتعيش أسبوع. لو انتهت نبدأ رفع جديد من الأول.
      this.sessionUri = '';
      this.uploaded = 0;
      this.needsSync = false;
    } else {
      this.needsSync = Boolean(this.sessionUri);
    }
    this.error = navigator.onLine ? err.message : 'مفيش اتصال بالإنترنت — الرفع هيكمل لوحده لما النت يرجع';
    this.setState('retrying');
    this.retryTimer = setTimeout(() => this.pump(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  // بعد ما المدرب يعيد ربط الإكستنشن أو يصلّح المحاضرة
  resumeAfterAuth() {
    this.error = '';
    this.state = 'waiting';
    this.needsSync = Boolean(this.sessionUri);
    this.pump();
  }

  async finish(file) {
    this.result = file;
    if (this.total !== null) this.uploaded = this.total;
    this.setState('done');
    await patchRecording(this.rec.id, {
      drive: { done: true, fileId: file.id, webViewLink: file.webViewLink || '', uploaded: this.uploaded },
    });
    DriveUploader.instances.delete(this);
    this.resolveDone(file);
  }

  async persist() {
    await patchRecording(this.rec.id, {
      drive: { sessionUri: this.sessionUri, uploaded: this.uploaded, recordingId: this.recordingId, folderPath: this.folderPath },
    });
  }

  setState(state) {
    if (state !== 'retrying' && state !== 'needs-auth' && state !== 'failed') this.error = '';
    this.state = state;
    this.onChange(this);
  }

  whenDone() {
    return this.donePromise;
  }
}

window.addEventListener('online', () => {
  for (const uploader of DriveUploader.instances) uploader.pump();
});
