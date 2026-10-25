// Worker بيكتب التسجيل على الجهاز (OPFS) أول بأول.
// createSyncAccessHandle بيكتب على الديسك فورًا، فلو الكروم قفل فجأة اللي اتسجل مبيضيعش.

let handle = null;
let size = 0;

self.onmessage = async (event) => {
  const { id, op } = event.data;
  try {
    if (op === 'open') {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(event.data.name, { create: true });
      handle = await fileHandle.createSyncAccessHandle();
      size = handle.getSize();
      reply(id, size);
    } else if (op === 'append') {
      const bytes = new Uint8Array(event.data.buffer);
      handle.write(bytes, { at: size });
      handle.flush();
      size += bytes.byteLength;
      reply(id, size);
    } else if (op === 'read') {
      const length = Math.max(0, Math.min(event.data.length, size - event.data.offset));
      const out = new Uint8Array(length);
      if (length) handle.read(out, { at: event.data.offset });
      self.postMessage({ id, result: out.buffer }, [out.buffer]);
    } else if (op === 'close') {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      reply(id, size);
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};

function reply(id, result) {
  self.postMessage({ id, result });
}
