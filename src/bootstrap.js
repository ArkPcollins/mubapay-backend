'use strict';
/** Shared startup: DB connection, transaction check, indexes, system accounts, job registry. */
const db = require('./lib/db');
const logger = require('./lib/logger');
const infra = require('./infra');
const ledger = require('./modules/ledger/ledger.service');

function loadModels() {
  require('./modules/users/user.model');
  require('./modules/auth/auth.models');
  require('./modules/audit/audit.model');
  require('./modules/settings/settings.model');
  require('./modules/ledger/ledger.models');
  require('./modules/payments/payment.models');
  require('./modules/wallet/wallet.models');
  require('./modules/notifications/notification.model');
  require('./modules/legal/legal.models');
  require('./modules/marketplace/marketplace.models');
  require('./modules/savings/savings.models');
  require('./modules/realestate/realestate.models');
  require('./modules/verification/verification.models');
  require('./modules/messaging/messaging.service');
  require('./modules/support/support.service');
  require('./modules/approvals/approvals');
  require('./modules/approvals/approval.actions');
  require('./modules/reconciliation/reconciliation.service');
  require('./modules/reports/reports.service');
  require('./modules/deliveries/deliveries.service');
  // services that register payment purposes / refund subjects
  require('./modules/wallet/wallet.service');
  require('./modules/marketplace/orders.service');
  require('./modules/savings/savings.service');
  require('./modules/realestate/appointments.service');
}

async function bootstrap({ syncIndexes = true } = {}) {
  loadModels();
  await db.connect();
  const rs = await db.assertTransactionCapable();
  logger.info(rs, 'MongoDB transaction support confirmed');
  if (syncIndexes) {
    // createIndexes (non-destructive); destructive index changes go through migrations.
    for (const m of Object.values(db.mongoose.models)) {
      // eslint-disable-next-line no-await-in-loop
      await m.createCollection().catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await m.createIndexes().catch((err) => logger.warn({ model: m.modelName, err: err.message }, 'index creation warning'));
    }
  }
  await ledger.ensureSystemAccounts();
  await infra.init();
  return { replicaSet: rs.setName };
}

module.exports = { bootstrap, loadModels };
