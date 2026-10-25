'use strict';
/**
 * Private document storage for identity, ownership and agreement documents.
 * Files are encrypted at rest (AES-256-GCM, DATA_ENCRYPTION_KEY) on a private
 * volume that is never served statically. Access happens only through
 * short-lived, single-subject download tokens issued after an authorisation
 * check, and every access is audited.
 *
 * Multi-instance deployments must mount PRIVATE_STORAGE_DIR on shared,
 * access-restricted storage (or replace this adapter with an S3-compatible
 * private bucket using server-side encryption — same interface).
 */
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { encrypt, decrypt } = require('../../lib/crypto');
const { E } = require('../../lib/errors');

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf', 'image/webp': '.webp' };
const MAX_BYTES = 8 * 1024 * 1024;

function root() {
  return path.resolve(config.PRIVATE_STORAGE_DIR);
}

function sniff(buf) {
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function save(buffer, { declaredType, category }) {
  if (!buffer?.length) throw E.validation([{ path: 'file', message: 'File is empty' }]);
  if (buffer.length > MAX_BYTES) throw E.validation([{ path: 'file', message: 'File must be 8MB or smaller' }]);
  const actual = sniff(buffer);
  if (!actual || !ALLOWED[actual]) throw E.validation([{ path: 'file', message: 'Only JPEG, PNG, WEBP or PDF files are accepted' }]);
  if (declaredType && declaredType !== actual && !(declaredType === 'image/jpg' && actual === 'image/jpeg')) throw E.validation([{ path: 'file', message: 'File type does not match its contents' }]);
  const key = `${category}/${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString('hex')}${ALLOWED[actual]}.enc`;
  const full = path.join(root(), key);
  await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await fs.writeFile(full, encrypt(buffer), { mode: 0o600 });
  return { storageKey: key, contentType: actual, sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

async function read(storageKey) {
  const full = path.join(root(), storageKey);
  if (!full.startsWith(root() + path.sep)) throw E.forbidden();
  return decrypt(await fs.readFile(full));
}

async function remove(storageKey) {
  const full = path.join(root(), storageKey);
  if (!full.startsWith(root() + path.sep)) throw E.forbidden();
  await fs.rm(full, { force: true });
}

/** Short-lived download token bound to a document id and the requesting user. */
function issueDownloadToken(documentId, userId) {
  const exp = Math.floor(Date.now() / 1000) + config.DOWNLOAD_TOKEN_TTL_SECONDS;
  const body = `${documentId}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', config.encryptionKey).update(`dl:${body}`).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${sig}`;
}

function verifyDownloadToken(token) {
  const [b64, sig] = String(token || '').split('.');
  if (!b64 || !sig) return null;
  const body = Buffer.from(b64, 'base64url').toString();
  const expected = crypto.createHmac('sha256', config.encryptionKey).update(`dl:${body}`).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const [documentId, userId, exp] = body.split('.');
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return { documentId, userId };
}

module.exports = { save, read, remove, issueDownloadToken, verifyDownloadToken, sniff };
