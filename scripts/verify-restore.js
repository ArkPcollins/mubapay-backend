'use strict';
/**
 * Restore verification: run against a RESTORED (non-production) database.
 * Checks ledger invariants, counts of key collections and that every
 * completed withdrawal / fulfilled payment has its ledger transaction.
 * Exit code 0 = restore verified; 1 = problems found.
 *   MONGODB_URI=<restored db uri> node scripts/verify-restore.js
 */
const db = require('../src/lib/db');
const { loadModels } = require('../src/bootstrap');

async function main() {
  loadModels();
  await db.connect();
  const ledger = require('../src/modules/ledger/ledger.service');
  const { LedgerTransaction } = require('../src/modules/ledger/ledger.models');
  const { PaymentAttempt } = require('../src/modules/payments/payment.models');
  const { Withdrawal } = require('../src/modules/wallet/wallet.models');
  const { User } = require('../src/modules/users/user.model');
  const report = { users: await User.countDocuments(), ledgerTransactions: await LedgerTransaction.countDocuments() };
  const inv = await ledger.checkInvariants();
  report.invariants = { ok: inv.ok, problems: inv.problems.slice(0, 20), accountsChecked: inv.accountsChecked };
  const fulfilled = await PaymentAttempt.find({ fulfilledAt: { $ne: null } }, { fulfillmentReference: 1 }).lean();
  const refs = new Set((await LedgerTransaction.find({ reference: { $in: fulfilled.map((f) => f.fulfillmentReference) } }, { reference: 1 }).lean()).map((t) => t.reference));
  report.paymentsMissingLedger = fulfilled.filter((f) => !refs.has(f.fulfillmentReference)).length;
  const done = await Withdrawal.find({ status: 'completed' }, { reference: 1 }).lean();
  const wrefs = new Set((await LedgerTransaction.find({ reference: { $in: done.map((w) => `${w.reference}-PAID`) } }, { reference: 1 }).lean()).map((t) => t.reference));
  report.withdrawalsMissingLedger = done.filter((w) => !wrefs.has(`${w.reference}-PAID`)).length;
  console.log(JSON.stringify(report, null, 2));
  const okAll = inv.ok && report.paymentsMissingLedger === 0 && report.withdrawalsMissingLedger === 0;
  console.log(okAll ? 'RESTORE VERIFIED' : 'RESTORE VERIFICATION FAILED');
  await db.disconnect();
  process.exit(okAll ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err.message);
  process.exit(1);
});
