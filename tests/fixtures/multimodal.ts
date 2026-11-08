import { crc32, deflateSync } from "node:zlib";

/** A real two-colour PNG; no text or metadata carries its visual answer. */
export function fixturePNG(reversed = false): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name); const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([header, type, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(32 * 97);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const index = y * 97 + 1 + x * 3;
    pixels[index + ((x < 16) !== reversed ? 0 : 2)] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
