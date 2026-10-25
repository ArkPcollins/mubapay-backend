'use strict';
/**
 * Background job registry shared by both variants. The infrastructure layer
 * (MongoDB queue or BullMQ) decides HOW jobs run; this file decides WHAT runs.
 * Every handler is idempotent: jobs may be delivered more than once.
 */
const infra = require('../infra');
const logger = require('../lib/logger');
const audit = require('../modules/audit/audit.service');

function register() {
  const q = infra.queue;
  const notifications = require('../modules/notifications/notifications.service');
  const webhooks = require('../modules/webhooks/webhooks.service');
  const recon = require('../modules/reconciliation/reconciliation.service');
  const wallet = require('../modules/wallet/wallet.service');
  const savings = require('../modules/savings/savings.service');
  const orders = require('../modules/marketplace/orders.service');
  const products = require('../modules/marketplace/products.service');
  const deliveries = require('../modules/deliveries/deliveries.service');
  const appointments = require('../modules/realestate/appointments.service');
  const refunds = require('../modules/refunds/refunds.service');
  const reports = require('../modules/reports/reports.service');
  const payments = require('../modules/payments/payments.service');
  const support = require('../modules/support/support.service');

  // webhook processors (provider → domain)
  webhooks.registerProcessor('paystack', async (ev) => {
    const { event, data } = ev.payload;
    if (event === 'charge.success') {
      await payments.verifyAndFulfil(data.reference, { source: 'webhook' });
      return { handled: true };
    }
    if (String(event).startsWith('transfer.')) return wallet.handleTransferEvent(event, data);
    if (String(event).startsWith('refund.')) {
      await refunds.checkCardRefunds();
      return { handled: true };
    }
    return { ignored: true, reason: `unhandled event ${event}` };
  });
  webhooks.registerProcessor('shipbubble', (ev) => deliveries.handleShipbubbleEvent(ev));
  webhooks.registerProcessor('whatsapp', (ev) => support.handleWhatsAppInbound(ev));

  // on-demand jobs
  q.registerHandler('notification.email', ({ id }) => notifications.deliverEmail(id));
  q.registerHandler('webhook.process', ({ id }) => webhooks.processEvent(id));
  q.registerHandler('payment.verify', ({ reference }) => payments.verifyAndFulfil(reference, { source: 'job' }));
  q.registerHandler('delivery.book', ({ deliveryRequestId }) => deliveries.book(deliveryRequestId));

  // scheduled jobs (durable sweepers make every flow recoverable without the queue)
  const sweepers = {
    'sweep.notifications': () => notifications.sweepPendingEmails(),
    'sweep.webhooks': () => webhooks.sweep(),
    'sweep.payments': () => recon.sweepPendingPayments(),
    'sweep.payouts': () => wallet.sweepPayouts(),
    'sweep.card_refunds': () => refunds.checkCardRefunds(),
  };
  const scheduled = {
    ...sweepers,
    'marketplace.expire_unpaid': () => orders.expireUnpaid(),
    'marketplace.settlements': () => orders.runSettlements(),
    'marketplace.search_alerts': () => products.runProductSearchAlerts(),
    'delivery.poll_tracking': () => deliveries.pollTracking(),
    'savings.due_contributions': () => savings.runDueContributions(),
    'savings.reminders': () => savings.sendReminders(),
    'savings.maturities': () => savings.runMaturities(),
    'property.viewing_releases': () => appointments.runReleases(),
    'property.viewing_reminders': () => appointments.sendReminders(),
    'recon.paystack_daily': () => recon.reconcilePaystack({}),
    'recon.payouts': () => recon.reconcilePayouts({}),
    'recon.ledger_invariants': () => recon.checkLedger({}),
    'monitor.webhook_freshness': () => webhooks.checkWebhookFreshness(),
    'reports.daily': () => reports.runScheduled('daily'),
    'reports.weekly': () => reports.runScheduled('weekly'),
    'reports.monthly': () => reports.runScheduled('monthly'),
  };
  for (const [name, fn] of Object.entries(scheduled)) q.registerHandler(name, () => fn());
  module.exports.__handlers = scheduled; // exposed for operational tooling & tests (run a job now)

  q.schedule('sweep.notifications', { everyMs: 60e3 });
  q.schedule('sweep.webhooks', { everyMs: 60e3 });
  q.schedule('sweep.payments', { everyMs: 2 * 60e3 });
  q.schedule('sweep.payouts', { everyMs: 5 * 60e3 });
  q.schedule('sweep.card_refunds', { everyMs: 30 * 60e3 });
  q.schedule('marketplace.expire_unpaid', { everyMs: 5 * 60e3 });
  q.schedule('marketplace.settlements', { everyMs: 15 * 60e3 });
  q.schedule('marketplace.search_alerts', { cron: '0 * * * *' });
  q.schedule('delivery.poll_tracking', { everyMs: 30 * 60e3 });
  q.schedule('savings.due_contributions', { everyMs: 15 * 60e3 });
  q.schedule('savings.reminders', { cron: '0 * * * *' });
  q.schedule('savings.maturities', { cron: '10 * * * *' });
  q.schedule('property.viewing_releases', { everyMs: 15 * 60e3 });
  q.schedule('property.viewing_reminders', { cron: '0 * * * *' });
  q.schedule('recon.paystack_daily', { cron: '30 2 * * *' });
  q.schedule('recon.payouts', { cron: '0 */2 * * *' });
  q.schedule('recon.ledger_invariants', { cron: '15 * * * *' });
  q.schedule('monitor.webhook_freshness', { cron: '0 */3 * * *' });
  q.schedule('reports.daily', { cron: '0 6 * * *' });
  q.schedule('reports.weekly', { cron: '0 7 * * 1' });
  q.schedule('reports.monthly', { cron: '0 8 1 * *' });

  q.onPermanentFailure = (job, err) => {
    audit.raiseAlert({ severity: 'warning', type: 'job.failed', message: `Job ${job.name} failed permanently: ${err.message}`, refType: 'job', refId: String(job._id), dedupeKey: `job_failed:${job.name}` });
  };

  // Redis variant: keep durable flows moving while Redis is down.
  infra.startDegradedFallback(Object.values(sweepers));
  logger.info({ scheduled: Object.keys(scheduled).length }, 'job handlers registered');
  return { scheduled: Object.keys(scheduled) };
}

module.exports = { register };
