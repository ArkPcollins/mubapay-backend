'use strict';
/**
 * SEO helpers for the separately hosted frontend: a sitemap of ONLY
 * published, public product and property pages (never drafts, rejected,
 * hidden, archived or private content) and a robots.txt.
 */
const express = require('express');
const config = require('../../config');
const { Product } = require('../marketplace/marketplace.models');
const { Property } = require('../realestate/realestate.models');
const { asyncHandler: h } = require('../../lib/http');

const r = express.Router();
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

r.get('/sitemap.xml', h(async (_req, res) => {
  const [products, properties] = await Promise.all([
    Product.find({ status: 'published' }, { slug: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(20000).lean(),
    Property.find({ status: 'published' }, { slug: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(20000).lean(),
  ]);
  const base = config.FRONTEND_URL.replace(/\/$/, '');
  const statics = ['/', '/savings', '/marketplace', '/real-estate', '/how-it-works', '/about', '/contact', '/faqs', '/legal'];
  const urls = [
    ...statics.map((p) => `<url><loc>${xmlEsc(base + p)}</loc></url>`),
    ...products.map((p) => `<url><loc>${xmlEsc(`${base}/marketplace/${p.slug}`)}</loc><lastmod>${p.updatedAt.toISOString()}</lastmod></url>`),
    ...properties.map((p) => `<url><loc>${xmlEsc(`${base}/real-estate/${p.slug}`)}</loc><lastmod>${p.updatedAt.toISOString()}</lastmod></url>`),
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
}));

r.get('/robots.txt', (_req, res) => {
  const base = config.FRONTEND_URL.replace(/\/$/, '');
  const body = config.isProduction
    ? `User-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /admin/\nDisallow: /login\nDisallow: /register\nSitemap: ${config.API_PUBLIC_URL}/api/v1/seo/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  res.type('text/plain').send(body.replace('{base}', base));
});

module.exports = r;
