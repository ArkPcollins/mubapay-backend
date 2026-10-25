'use strict';
/**
 * Cloudinary — PUBLIC product/property media only. Browsers upload directly
 * to https://api.cloudinary.com/v1_1/<cloud>/<resource>/upload using a
 * short-lived signature generated here (SHA-1 of the alphabetically sorted
 * parameters + API secret, per Cloudinary's signed-upload spec).
 *
 * Identity documents, ownership documents and agreements are NEVER sent to
 * Cloudinary; they use encrypted private storage (providers/storage).
 */
const crypto = require('crypto');
const config = require('../../config');
const { E } = require('../../lib/errors');

const FOLDERS = { products: 'products', properties: 'properties', floorplans: 'properties/floorplans', tours: 'properties/tours' };

function requireConfigured() {
  if (!config.integrations.cloudinary) throw E.notConfigured('Cloudinary media uploads', 'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET');
}

function signParams(params) {
  const toSign = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== '').sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + config.CLOUDINARY_API_SECRET).digest('hex');
}

function signUpload({ purpose, ownerId }) {
  requireConfigured();
  const folder = `${config.CLOUDINARY_FOLDER}/${FOLDERS[purpose] || 'misc'}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, timestamp, context: `owner=${ownerId}` };
  return { cloudName: config.CLOUDINARY_CLOUD_NAME, apiKey: config.CLOUDINARY_API_KEY, uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/auto/upload`, ...params, signature: signParams(params) };
}

/** Accept only media hosted on our Cloudinary cloud & folder. */
function assertOwnMedia(url) {
  if (!config.integrations.cloudinary) throw E.validation([{ path: 'images', message: 'Media uploads are not configured on this server' }]);
  const prefix = `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/`;
  if (typeof url !== 'string' || !url.startsWith(prefix) || !url.includes(`/${config.CLOUDINARY_FOLDER}/`)) {
    throw E.validation([{ path: 'images', message: 'Images must be uploaded through MubaPay' }]);
  }
  return url;
}

function status() {
  return { implemented: true, configured: config.integrations.cloudinary };
}

module.exports = { signUpload, assertOwnMedia, signParams, status, requireConfigured };
