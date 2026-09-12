'use strict';
/*
 secrets — API keys at rest (docs/ACCOUNTS-CONTRACT.md, T-019).

 One file, ~/.claude/mission-control/secrets.json:
   { version: 1, keys: { <providerId>: { enc: <base64 of safeStorage.encryptString>, setAt: <ISO> } } }

 Plain text never touches the disk and never leaves the main process: the renderer only ever learns `has`
 and `setAt`. On Windows safeStorage is DPAPI, so the ciphertext is bound to this Windows user account.

 The encryptor is injected rather than required, for two reasons: the unit tests run under plain node with a
 fake, and main.js can hand in Electron's safeStorage only once `app` is ready. When encryption is
 unavailable every write is refused with an `error` — writing a key in the clear is not an option we offer.
*/
const fs = require('fs');
const path = require('path');

/** The adapter main.js wraps around Electron's safeStorage. */
const electronEncryptor = (safeStorage) => ({
  available: () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; } },
  encrypt: (plain) => safeStorage.encryptString(String(plain)),
  decrypt: (buf) => safeStorage.decryptString(buf),
});

class Secrets {
  constructor(file, encryptor) { this.file = file; this.enc = encryptor || { available: () => false, encrypt: () => { throw new Error('no encryptor'); }, decrypt: () => { throw new Error('no encryptor'); } }; }
  available() { try { return !!this.enc.available(); } catch { return false; } }
  load() {
    let d = null; try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { d = null; }
    if (!d || typeof d !== 'object' || !d.keys || typeof d.keys !== 'object') return { version: 1, keys: {} };
    return { version: 1, keys: d.keys };
  }
  save(d) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ version: 1, keys: d.keys }, null, 2)); return d; }
  /** `{ ok, setAt }`, or `{ error }` when encryption is unavailable or the value is empty. */
  set(id, value) {
    const v = String(value == null ? '' : value).trim();
    if (!id) return { error: 'no provider' };
    if (!v) return this.remove(id);                       // saving an empty field means "forget it"
    if (!this.available()) return { error: 'this machine cannot encrypt secrets (Electron safeStorage is unavailable), so Mission Control will not store a key' };
    let enc; try { enc = Buffer.from(this.enc.encrypt(v)).toString('base64'); } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
    const d = this.load(); const setAt = new Date().toISOString();
    d.keys[id] = { enc, setAt };
    try { this.save(d); } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
    return { ok: true, setAt };
  }
  has(id) { return !!this.load().keys[id]; }
  /** Plain text. Main process only — this value is never sent over IPC. Null when absent or undecryptable. */
  get(id) {
    const r = this.load().keys[id]; if (!r || !r.enc) return null;
    try { return this.enc.decrypt(Buffer.from(r.enc, 'base64')); } catch { return null; }
  }
  remove(id) { const d = this.load(); if (!d.keys[id]) return { ok: true }; delete d.keys[id]; try { this.save(d); } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; } return { ok: true }; }
  /** What the renderer may know: which keys exist and when they were saved. Never the values. */
  list() { const d = this.load(); return Object.keys(d.keys).map((id) => ({ id, setAt: d.keys[id].setAt || null })); }
  /** `{ id: { setAt } }` — the shape providers.statusAll() wants. */
  info() { const out = {}; for (const r of this.list()) out[r.id] = { setAt: r.setAt }; return out; }
  /** `{ id: plaintext }` for env assembly. Main process only; keys that fail to decrypt are left out. */
  map() { const out = {}; for (const r of this.list()) { const v = this.get(r.id); if (v) out[r.id] = v; } return out; }
}

module.exports = { Secrets, electronEncryptor };
