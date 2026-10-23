  // Build one bounded ZIP at a time without a CDN dependency.
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xEDB88320 & -(value & 1));
    return value >>> 0;
  });
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF];
    return (crc ^ -1) >>> 0;
  }
export async function zip(entries: any[], jsonPartContent: (part: any) => string, colors: any) {
    if (entries.length > 65535) throw new Error('ZIP contains too many files');
    const encoder = new TextEncoder();
    const parts = [], central = [];
    let offset = 0, centralLength = 0;
    const u16 = (view, at, n) => view.setUint16(at, n, true);
    const u32 = (view, at, n) => view.setUint32(at, n >>> 0, true);
    for (const [name, part] of entries) {
      const filename = encoder.encode(name), raw = encoder.encode(jsonPartContent(part)), crc = crc32(raw);
      if (raw.length !== part.bytes) throw new Error(`JSON size changed while exporting ${name}`);
      let bytes = raw, method = 0;
      if (typeof CompressionStream !== 'undefined') {
        try {
          const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
          bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          method = 8;
        } catch (e) { console.warn('%cAzureHound warning%c  DEFLATE unavailable; using stored ZIP entry: %s', colors.partial, colors.text, e.message); }
      }
      if (filename.length > 65535 || raw.length > 0xFFFFFFFF || bytes.length > 0xFFFFFFFF) throw new Error(`ZIP entry too large: ${name}`);
      const local = new Uint8Array(30 + filename.length), lv = new DataView(local.buffer);
      u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x800); u16(lv, 8, method); u32(lv, 14, crc);
      u32(lv, 18, bytes.length); u32(lv, 22, raw.length); u16(lv, 26, filename.length);
      local.set(filename, 30); parts.push(local, bytes);
      const header = new Uint8Array(46 + filename.length), hv = new DataView(header.buffer);
      u32(hv, 0, 0x02014b50); u16(hv, 4, 20); u16(hv, 6, 20); u16(hv, 8, 0x800); u16(hv, 10, method);
      u32(hv, 16, crc); u32(hv, 20, bytes.length); u32(hv, 24, raw.length);
      u16(hv, 28, filename.length); u32(hv, 42, offset); header.set(filename, 46);
      central.push(header); centralLength += header.length; offset += local.length + bytes.length;
    }
    if (offset + centralLength > 0xFFFFFFFF) throw new Error('ZIP exceeds the ZIP32 size limit');
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    u32(ev, 0, 0x06054b50); u16(ev, 8, entries.length); u16(ev, 10, entries.length);
    u32(ev, 12, centralLength); u32(ev, 16, offset);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
