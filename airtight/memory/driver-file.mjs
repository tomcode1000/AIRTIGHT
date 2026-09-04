/**
 * Local memory driver — durable, dependency-free, crash-safe.
 *
 * Stands in for Sibyl Memory during development, chaos testing and offline
 * work, and is the substrate the SIGKILL harness runs against. Same record
 * shapes as `driver-sibyl.mjs`, so agent code is identical either way.
 *
 * ── Why this is crash-safe ──────────────────────────────────────────────────
 * Write-before-act is worthless if the write itself can be torn in half by a
 * kill -9. Every write here is: serialise → write to a temp file → fsync the
 * file → atomically rename over the target → fsync the directory. A reader
 * therefore sees either the whole previous record or the whole new one, never
 * a partial. The rename is atomic on POSIX and on Windows (libuv uses
 * MoveFileEx with MOVEFILE_REPLACE_EXISTING).
 *
 * Without the fsync before rename, the rename can land while the file's bytes
 * are still in the page cache — the record would be present but empty after a
 * power loss. That is exactly the failure this project claims to prevent.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Percent-encode anything outside [A-Za-z0-9_-] so record names map to legal
 * filenames on every platform and cannot escape the store.
 *
 * Necessary, not cosmetic: attestation names are `<deal_id>:<kind>`, and ':'
 * is illegal in Windows filenames. Encoding is total and reversible, so no
 * two distinct record names can ever collide onto one file.
 */
export function encodeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
export function decodeName(s) {
  return String(s).replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export class FileDriver {
  constructor(root) {
    if (!root) throw new Error('FileDriver: root path required');
    this.root = path.resolve(root);
  }

  #dir(category) { return path.join(this.root, encodeName(category)); }
  #file(category, name) { return path.join(this.#dir(category), encodeName(name) + '.json'); }

  #fsyncDir(dir) {
    // Directory entries need their own fsync, or the rename may not survive.
    // Not supported on every Windows filesystem — a failure here does not
    // invalidate the file's own fsync, so it is non-fatal.
    let fd;
    try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  write(category, name, body) {
    const dir = this.#dir(category);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.#file(category, name);
    const tmp = target + '.' + process.pid + '.tmp';
    const payload = JSON.stringify({ category, name, body }, null, 2);

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);            // bytes on disk BEFORE the rename
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);    // atomic swap
    this.#fsyncDir(dir);
    return { category, name, body };
  }

  read(category, name) {
    try {
      const raw = fs.readFileSync(this.#file(category, name), 'utf8');
      const rec = JSON.parse(raw);
      return rec?.body ?? null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      // Unparseable content is corruption, not absence. Surface it so callers
      // REFUSE rather than silently treating a damaged record as a fresh deal.
      if (e instanceof SyntaxError) throw new Error(`corrupt record ${category}/${name}: ${e.message}`);
      throw e;
    }
  }

  list(category) {
    try {
      return fs.readdirSync(this.#dir(category))
        .filter(f => f.endsWith('.json'))
        .map(f => decodeName(f.slice(0, -5)))
        .sort();
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  remove(category, name) {
    try { fs.unlinkSync(this.#file(category, name)); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }

  /** Irreversible. Used by the deletion test, which must wipe for real. */
  destroyAll() { fs.rmSync(this.root, { recursive: true, force: true }); }
}

export default FileDriver;
