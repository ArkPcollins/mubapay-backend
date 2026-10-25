'use strict';
const crypto = require('crypto');
const config = require('../config');

/** AES-256-GCM encryption for sensitive fields and private files. */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const data = Buffer.concat([cipher.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]);
}

function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

const encryptString = (s) => (s == null ? s : encrypt(s).toString('base64'));
const decryptString = (s) => (s == null ? s : decrypt(Buffer.from(s, 'base64')).toString('utf8'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacSha256 = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function randomDigits(n = 6) {
  let out = '';
  for (let i = 0; i < n; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Deterministic stable JSON (sorted keys) used for request hashing. */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

module.exports = { encrypt, decrypt, encryptString, decryptString, sha256, hmacSha256, randomToken, randomDigits, safeEqual, stableStringify };
