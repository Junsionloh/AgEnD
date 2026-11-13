/**
 * AGEND-257: the ZIP reading and writing Skill export / import needs. No package: Node's own zlib inflates and deflates, the rest is
 * the format's fixed records. A ZIP is untrusted input here (a person uploads it), so the reader is strict and refuses rather than repairs:
 *
 *  - a name that would leave the folder it is read into (`../x`, `/x`, `C:\x`, a backslash, a NUL) — the "zip slip";
 *  - a symbolic link or any entry that is not a plain file or folder;
 *  - an encrypted entry, ZIP64, a method other than stored / deflate, a multi-disk archive;
 *  - more entries, or more bytes once unpacked, than the limits (a lying header cannot pass: inflating stops at the size it declared);
 *  - a CRC that does not match, or two entries with the same name (also by case).
 *
 * Nothing here touches the disk: the reader returns names and bytes, and the library's own rules (schema.ts) decide what may be stored.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipLimits { archiveBytes: number; totalBytes: number; entryBytes: number; entries: number }
export const ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  /** The uploaded file itself. */
  archiveBytes: 16 * 1024 * 1024,
  /** All entries together, once unpacked. */
  totalBytes: 32 * 1024 * 1024,
  /** One entry, once unpacked (a skill's largest file is 200 KiB, see LIBRARY_LIMITS.skillFileBytes). */
  entryBytes: 200 * 1024,
  entries: 4000,
});

export type ZipErrorCode = "bad_archive" | "invalid_path" | "unsafe_item" | "too_large" | "too_many_files" | "duplicate_path";
export interface ZipError { ok: false; error: ZipErrorCode; path?: string; detail?: string }
export interface ZipEntry { name: string; data: Buffer }
export interface ZipRead { ok: true; entries: ZipEntry[]; /** Names left out on purpose (macOS / Windows file-manager litter). */ ignored: string[] }

const fail = (error: ZipErrorCode, extra: { path?: string; detail?: string } = {}): ZipError => ({ ok: false, error, ...extra });
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
// The fixed time of every entry (1980-01-01 00:00): the same files always make the same archive.
const DOS_TIME = 0, DOS_DATE = 0x0021;
const FLAG_ENCRYPTED = 0x0001, FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Whether the bytes begin like a ZIP (a local header, or an empty archive's end record). */
export const looksLikeZip = (b: Buffer): boolean => b.length >= 4 && b.readUInt32LE(0) === SIG_LOCAL || b.length >= 22 && b.readUInt32LE(0) === SIG_END;

// ── Writing ────────────────────────────────────────────────────────────

/** The files as one archive: names as given (`/`-separated, UTF-8), deflated when that is smaller, in the order given. */
export function writeZip(entries: ReadonlyArray<ZipEntry>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, centralBytes = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name, "utf8");
    const packed = data.length ? deflateRawSync(data, { level: 9 }) : data;
    const deflated = data.length > 0 && packed.length < data.length;
    const body = deflated ? packed : data;
    const method = deflated ? 8 : 0, checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(FLAG_UTF8, 6); header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10); header.writeUInt16LE(DOS_DATE, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(SIG_CENTRAL, 0); dir.writeUInt16LE(0x0314, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(FLAG_UTF8, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12); dir.writeUInt16LE(DOS_DATE, 14); dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    central.push(dir, filename); centralBytes += dir.length + filename.length;
    offset += header.length + filename.length + body.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// ── Reading ────────────────────────────────────────────────────────────

/** The macOS and Windows file managers add these to an archive; they are not part of the skill and are left out. */
const isLitter = (name: string): boolean => name.startsWith("__MACOSX/") || name.split("/").some((seg) => seg === ".DS_Store" || seg === "Thumbs.db");

/** What is wrong with an entry's name (null when it is a plain relative path). */
function unsafeName(name: string): boolean {
  if (!name || name.includes("\u0000") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((seg, i, all) => seg === ".." || seg === "." || (seg === "" && i !== all.length - 1));
}

export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): ZipRead | ZipError {
  const max = { ...ZIP_LIMITS, ...limits };
  if (buf.length > max.archiveBytes) return fail("too_large");
  if (buf.length < 22) return fail("bad_archive");
  // The end record sits at the very end, or before a comment of up to 64 KiB.
  let end = -1;
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--) {
    if (buf.readUInt32LE(at) === SIG_END && at + 22 + buf.readUInt16LE(at + 20) === buf.length) { end = at; break; }
  }
  if (end < 0) return fail("bad_archive");
  const disk = buf.readUInt16LE(end + 4), cdDisk = buf.readUInt16LE(end + 6), onDisk = buf.readUInt16LE(end + 8), count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12), cdStart = buf.readUInt32LE(end + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) return fail("bad_archive", { detail: "multi_disk" });
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) return fail("bad_archive", { detail: "zip64" });
  if (count > max.entries) return fail("too_many_files");
  if (cdStart + cdSize > end) return fail("bad_archive");

  const out: ZipEntry[] = [], ignored: string[] = [];
  const seen = new Set<string>();
  let at = cdStart, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== SIG_CENTRAL) return fail("bad_archive");
    const madeBy = buf.readUInt16LE(at + 4), flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
    const packedSize = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38), localAt = buf.readUInt32LE(at + 42);
    if (at + 46 + nameLen + extraLen + commentLen > end) return fail("bad_archive");
    let name: string;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(at + 46, at + 46 + nameLen)); } catch { return fail("invalid_path"); }
    at += 46 + nameLen + extraLen + commentLen;
    if (isLitter(name)) { ignored.push(name.slice(0, 160)); continue; }
    const shown = name.slice(0, 160);
    if (unsafeName(name)) return fail("invalid_path", { path: shown });
    const isDir = name.endsWith("/");
    // The host system is the high byte of "made by": 3 = Unix, whose file type sits in the top half of the attributes. A link, a device, a pipe: refused.
    // On any host, the DOS "reparse point" attribute (a Windows link) is refused too.
    if (madeBy >> 8 === 3) {
      const type = (external >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) return fail("unsafe_item", { path: shown, detail: "link" });
    }
    if (external & 0x400) return fail("unsafe_item", { path: shown, detail: "link" });
    if (isDir) { if (size !== 0) return fail("bad_archive", { path: shown }); continue; }
    // The same name to a file system: a different case, or the same letter composed (é) / decomposed (e + ´, as macOS stores it).
    const key = name.normalize("NFC").toLowerCase();
    if (seen.has(key)) return fail("duplicate_path", { path: shown });
    seen.add(key);
    if (flags & FLAG_ENCRYPTED) return fail("bad_archive", { path: shown, detail: "encrypted" });
    if (method !== 0 && method !== 8) return fail("bad_archive", { path: shown, detail: "method" });
    if (size === 0xffffffff || packedSize === 0xffffffff) return fail("bad_archive", { detail: "zip64" });
    if (size > max.entryBytes) return fail("too_large", { path: shown });
    total += size;
    if (total > max.totalBytes) return fail("too_large");
    if (localAt + 30 > cdStart || buf.readUInt32LE(localAt) !== SIG_LOCAL) return fail("bad_archive", { path: shown });
    const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    if (start + packedSize > cdStart) return fail("bad_archive", { path: shown });
    const packed = buf.subarray(start, start + packedSize);
    let data: Buffer;
    if (method === 0) {
      if (packedSize !== size) return fail("bad_archive", { path: shown });
      data = Buffer.from(packed);
    } else {
      try { data = inflateRawSync(packed, { maxOutputLength: Math.max(1, size) }); } catch { return fail("bad_archive", { path: shown, detail: "inflate" }); }
      if (data.length !== size) return fail("bad_archive", { path: shown, detail: "size" });
    }
    if (crc32(data) !== crc) return fail("bad_archive", { path: shown, detail: "crc" });
    out.push({ name, data });
  }
  if (at !== cdStart + cdSize) return fail("bad_archive");
  return { ok: true, entries: out, ignored };
}
