'use strict';
/** Create all collections + indexes and the system chart of accounts. Idempotent. */
module.exports = {
  id: '001-initial-indexes',
  description: 'Create collections, indexes and system ledger accounts',
  async up({ mongoose }) {
    for (const m of Object.values(mongoose.models)) {
      await m.createCollection().catch(() => {});
      await m.createIndexes();
    }
    await require('../src/modules/ledger/ledger.service').ensureSystemAccounts();
  },
};
