// واجهة بسيطة للملف المؤقت على الجهاز.
// أثناء التسجيل الكتابة والقراءة بتعدي على الـ worker لأنه ماسك الملف.
// بعد ما الملف يتقفل بنقرا منه مباشرة.

export class LocalRecordingFile {
  constructor(fileName) {
    this.fileName = fileName;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.size = 0;
  }

  async open() {
    this.worker = new Worker(new URL('./storage-worker.js', import.meta.url));
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    this.size = await this.call({ op: 'open', name: this.fileName });
    return this.size;
  }

  async append(buffer) {
    this.size = await this.call({ op: 'append', buffer }, [buffer]);
    return this.size;
  }

  async read(offset, length) {
    if (this.worker) return this.call({ op: 'read', offset, length });
    const file = await this.getFile();
    return file.slice(offset, offset + length).arrayBuffer();
  }

  async close() {
    if (!this.worker) return this.size;
    this.size = await this.call({ op: 'close' });
    this.worker.terminate();
    this.worker = null;
    // أي قراءة كانت مستنية رد من الـ worker تتعاد من الملف المقفول
    for (const pending of this.pending.values()) pending.reject(new Error('الملف اتقفل أثناء القراءة'));
    this.pending.clear();
    return this.size;
  }

  async getFile() {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(this.fileName);
    return handle.getFile();
  }

  async exists() {
    try {
      const file = await this.getFile();
      this.size = file.size;
      return true;
    } catch {
      return false;
    }
  }

  call(message, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }
}
