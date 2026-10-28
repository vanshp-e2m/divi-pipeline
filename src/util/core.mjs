// Shared helpers: filesystem, hashing, logging, small math.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
export const readJsonIf = (p, dflt = null) => (fs.existsSync(p) ? readJson(p) : dflt);
export function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}
export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
export const ensureDir = (p) => (fs.mkdirSync(p, { recursive: true }), p);
export const exists = (p) => fs.existsSync(p);

export const sha = (data, n = 64) => crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex').slice(0, n);
export const fileSha = (p, n = 16) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, n);

// Short, stable, CSS-safe id derived from a Figma node id ("I1:1615;877:67" -> "f2d-3k9x0a").
export const nodeClass = (sourceId) => 'f2d-' + sha(sourceId, 8);

export const round = (v, d = 2) => (v == null || Number.isNaN(v) ? v : Math.round(v * 10 ** d) / 10 ** d);
export const px = (v) => (v == null ? null : `${round(v, 2)}px`);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function timestampId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let level = LEVELS[process.env.F2D_LOG || 'info'] ?? 2;
export const setLogLevel = (l) => { level = LEVELS[l] ?? level; };
const SECRET_RE = /(figd_[A-Za-z0-9_-]+|[A-Za-z0-9]{4} [A-Za-z0-9]{4} [A-Za-z0-9]{4} [A-Za-z0-9]{4} [A-Za-z0-9]{4} [A-Za-z0-9]{4})/g;
export const redact = (s) => String(s).replace(SECRET_RE, '[redacted]');
export const log = {
  error: (...a) => level >= 0 && console.error(redact(a.join(' '))),
  warn: (...a) => level >= 1 && console.error(redact('warn: ' + a.join(' '))),
  info: (...a) => level >= 2 && console.error(redact(a.join(' '))),
  debug: (...a) => level >= 3 && console.error(redact('debug: ' + a.join(' '))),
};

export class F2DError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');
