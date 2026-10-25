'use strict';
/** Publish v1 legal document templates (flagged as NOT professionally reviewed). */
module.exports = {
  id: '002-legal-documents-v1',
  description: 'Publish initial legal document templates (require professional review)',
  async up() {
    const { LegalDocument } = require('../src/modules/legal/legal.models');
    const { docs } = require('../src/modules/legal/legal.templates');
    for (const [slug, [title, content]] of Object.entries(docs)) {
      const exists = await LegalDocument.exists({ slug });
      if (exists) continue;
      await LegalDocument.create({ slug, version: 1, title, content, status: 'published', effectiveAt: new Date(), publishedAt: new Date(), reviewedByProfessional: false, summaryOfChanges: 'Initial template' });
    }
  },
};
