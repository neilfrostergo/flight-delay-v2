'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96 bits — recommended for GCM
const TAG_LENGTH = 16;  // 128 bits — GCM authentication tag

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} "base64iv:base64tag:base64ciphertext"
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) {
    throw new Error('encrypt: plaintext must not be null or undefined');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, config.encryption.key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a value previously encrypted with `encrypt()`.
 * @param {string} stored "base64iv:base64tag:base64ciphertext"
 * @returns {string} original plaintext
 */
function decrypt(stored) {
  if (!stored || typeof stored !== 'string') {
    throw new Error('decrypt: stored value must be a non-empty string');
  }

  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('decrypt: invalid stored format — expected "iv:tag:ciphertext"');
  }

  const [ivB64, tagB64, cipherB64] = parts;

  const iv         = Buffer.from(ivB64,     'base64');
  const tag        = Buffer.from(tagB64,    'base64');
  const ciphertext = Buffer.from(cipherB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, config.encryption.key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Check whether a string looks like an encrypted value produced by `encrypt()`.
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return parts.every((p) => /^[A-Za-z0-9+/=]+$/.test(p));
}

module.exports = { encrypt, decrypt, isEncrypted };
