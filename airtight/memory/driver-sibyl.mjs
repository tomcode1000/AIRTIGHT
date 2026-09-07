/**
 * Sibyl Memory driver — the real substrate.
 *
 * Same interface as `driver-file.mjs`, so agent code is identical either way.
 * Writes go through the MCP server over stdio JSON-RPC, because that is the
 * only write path the plugin exposes: the `sibyl memory` CLI is read-only
 * (list / search / recall), so shelling out to it cannot store a deal.
 *
 * Verified against sibyl-memory-cli 0.4.0 / sibyl-memory-mcp 1.29.1:
 *   memory_remember(category, name, body) · memory_recall(category, name)
 *   memory_list(category, limit)          · memory_forget(category, name, reason)
 * Structured dict bodies round-trip intact, and records written by one process
 * are readable by a brand-new one. Both hold before `sibyl init` activation.
 *
 * One server process is kept alive for the lifetime of the driver. Spawning per
 * call costs roughly a second each, which would dominate a deal walk.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_DB = path.join(os.homedir(), '.sibyl-memory', 'memory.db');

export class SibylDriver {
  /**
   * @param bin  path to the sibyl-memory-mcp executable
   * @param db   optional SIBYL_MEMORY_DB override — the server honours it, and
   *             tests must use it so they never touch the user's real store
   */
  constructor({ bin = 'sibyl-memory-mcp', db = null, timeoutMs = 15000 } = {}) {
    this.bin = bin;
    this.db = db;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.ready = null;
  }

  get dbPath() { return this.db || process.env.SIBYL_MEMORY_DB || DEFAULT_DB; }

  #start() {
    if (this.ready) return this.ready;
    const env = { ...process.env };
    if (this.db) env.SIBYL_MEMORY_DB = this.db;

    this.proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg); }
      }
    });
    // A dead server must fail every in-flight call rather than hang until the
    // timeout: a stuck agent mid-deal is worse than a loud one.
    this.proc.on('exit', code => {
      for (const [, p] of this.pending) p.reject(new Error(`sibyl-memory-mcp exited (${code})`));
      this.pending.clear();
      this.ready = null;
    });

    this.ready = this.#rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'airtight', version: '0.1.0' },
    }).then(() => {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    });
    return this.ready;
  }

  #rpc(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sibyl ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: m => { clearTimeout(timer); resolve(m); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Sentinel for a genuine miss. Never conflated with a failure — see below. */
  static NOT_FOUND = Symbol('NOT_FOUND');

  async #call(name, args) {
    await this.#start();
    const msg = await this.#rpc('tools/call', { name, arguments: args });
    if (msg.error) throw new Error(`sibyl ${name}: ${msg.error.message}`);

    const text = msg.result?.content?.[0]?.text;
    if (text == null) throw new Error(`sibyl ${name}: empty response`);

    // Success bodies are pure JSON. Error bodies are the server's JSON payload
    // behind a FastMCP prefix ("Error executing tool <name>: {...}"), so fall
    // back to extracting the embedded object rather than losing the code.
    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch {
      const s = String(text), a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) { try { parsed = JSON.parse(s.slice(a, b + 1)); } catch {} }
    }

    // The server raises ToolError for failures, so the envelope carries
    // isError=true and the text is a JSON payload with a `code`.
    if (msg.result?.isError) {
      const code = parsed?.code ?? 'ERROR';
      // ONLY a NOT_FOUND may be reported as absence. Reading CAP_EXCEEDED or
      // TIER_GATED as "no record" would be dangerous: the agent would treat an
      // existing, already-paid deal as a fresh one and pay the seller twice.
      // Every other code must surface as a failure so the caller REFUSES.
      if (code === 'NOT_FOUND') return SibylDriver.NOT_FOUND;
      throw new Error(`sibyl ${name}: ${code} — ${parsed?.message ?? String(text).slice(0, 200)}`);
    }

    if (parsed == null) throw new Error(`sibyl ${name}: unparseable response`);
    return parsed;
  }

  async write(category, name, body) {
    const r = await this.#call('memory_remember', { category, name, body });
    if (r === SibylDriver.NOT_FOUND || !r?.ok) {
      throw new Error(`sibyl write failed: ${JSON.stringify(r).slice(0, 200)}`);
    }
    return { category, name, body };
  }

  async read(category, name) {
    const r = await this.#call('memory_recall', { category, name });
    // Absence is a legitimate answer and must be distinguishable from failure:
    // REFUSAL logic acts on "no record", but a transport or quota failure has
    // to propagate instead of masquerading as one.
    if (r === SibylDriver.NOT_FOUND) return null;
    return r.entity?.body ?? null;
  }

  async list(category) {
    const r = await this.#call('memory_list', { category, limit: 1000 });
    if (r === SibylDriver.NOT_FOUND) return [];
    return (r.results ?? []).map(e => e.name).sort();
  }

  /* ── HOT tier: one row per key, overwritten ──────────────────────────
   * Sibyl's own description: "ephemeral working state the agent updates
   * frequently - current focus, in-flight task list". Faster than an entity
   * write, and the right home for a position that changes every step. */

  async setState(key, body) {
    const r = await this.#call('memory_set_state', { key, body });
    if (r === SibylDriver.NOT_FOUND || !r?.ok) {
      throw new Error(`sibyl setState failed: ${JSON.stringify(r).slice(0, 200)}`);
    }
    return true;
  }

  async getState(key) {
    const r = await this.#call('memory_get_state', { key });
    // get_state reports a miss in-band as {ok:false, code:'NOT_FOUND'} rather
    // than raising, so absence has to be recognised here too.
    if (r === SibylDriver.NOT_FOUND) return null;
    if (r?.ok === false) {
      if (r.code === 'NOT_FOUND') return null;
      throw new Error(`sibyl getState: ${r.code ?? 'ERROR'}`);
    }
    return r?.body ?? null;
  }

  /* ── COLD tier: append-only journal ──────────────────────────────────
   * What was done, in order. Distinct from state: state is where we are,
   * the journal is what happened. An emergent agent needs both. */

  async recordEvent(kind, body, { category = null, name = null } = {}) {
    const args = { kind, body };
    if (category) args.category = category;
    if (name) args.name = name;
    const r = await this.#call('memory_record_event', args);
    return r !== SibylDriver.NOT_FOUND && !!r?.ok;
  }

  /**
   * Archive, not erase. `memory_forget` is a soft delete by design, so this
   * cannot stand in for the deletion test — see `destroyAll`.
   */
  async remove(category, name, reason = 'airtight remove') {
    const r = await this.#call('memory_forget', { category, name, reason });
    return r !== SibylDriver.NOT_FOUND && !!r.ok;
  }

  /**
   * Irreversible, for the deletion beat. `memory_forget` only archives, so
   * proving "memory deleted ⇒ core function breaks" requires removing the
   * database file itself.
   */
  destroyAll() {
    this.close();
    fs.rmSync(this.dbPath, { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(this.dbPath + suffix, { force: true });
  }

  close() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; this.ready = null; }
  }
}

export default SibylDriver;
