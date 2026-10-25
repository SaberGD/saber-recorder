// كروم بيكتب WebM من غير مدة (Duration)، فالمشغّلات مبتعرفش طول الفيديو والتقديم فيه بيبقى مش مضبوط.
// هنا بنضيف عنصر Duration جوه الـ Info في أول الملف. الباقي بيفضل زي ما هو (Blob بيشاور على نفس الملف، من غير نسخ).

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

export async function withWebmDuration(file, durationMs) {
  if (!durationMs) return file;
  try {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    const ebml = readElement(head, 0);
    if (ebml.id !== ID_EBML) return file;
    const segment = readElement(head, ebml.dataStart + ebml.size);
    if (segment.id !== ID_SEGMENT) return file;

    let pos = segment.dataStart;
    while (pos < head.length - 16) {
      const el = readElement(head, pos);
      if (el.id === ID_INFO) return patchInfo(file, head, pos, el, durationMs);
      if (el.id === ID_CLUSTER || el.unknownSize) break;
      pos = el.dataStart + el.size;
    }
  } catch (err) {
    console.warn('webm duration patch skipped', err);
  }
  return file;
}

function patchInfo(file, head, pos, info, durationMs) {
  const body = head.subarray(info.dataStart, info.dataStart + info.size);
  let scale = 1_000_000;
  for (let p = 0; p < body.length;) {
    const child = readElement(body, p);
    if (child.id === ID_DURATION) return file;
    if (child.id === ID_TIMECODE_SCALE) scale = readUint(body, child.dataStart, child.size);
    p = child.dataStart + child.size;
  }

  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, (durationMs * 1_000_000) / scale);

  return new Blob([
    head.subarray(0, pos),
    head.subarray(pos, pos + info.idLength),
    encodeSize(info.size + duration.length, info.sizeLength),
    body,
    duration,
    file.slice(info.dataStart + info.size),
  ], { type: file.type });
}

function readElement(buf, pos) {
  const idLength = vintLength(buf[pos]);
  if (idLength > 4) throw new Error('bad element id');
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + buf[pos + i];

  const sizePos = pos + idLength;
  const sizeLength = vintLength(buf[sizePos]);
  let size = buf[sizePos] & (0xff >> sizeLength);
  let allOnes = size === (0xff >> sizeLength);
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + buf[sizePos + i];
    allOnes = allOnes && buf[sizePos + i] === 0xff;
  }
  return { id, idLength, size, sizeLength, unknownSize: allOnes, dataStart: sizePos + sizeLength };
}

function vintLength(firstByte) {
  for (let len = 1; len <= 8; len++) {
    if (firstByte & (0x80 >> (len - 1))) return len;
  }
  throw new Error('bad vint');
}

function readUint(buf, start, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + buf[start + i];
  return value;
}

function encodeSize(value, preferredLength) {
  let length = preferredLength;
  while (value >= 2 ** (7 * length) - 1) length++;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}
