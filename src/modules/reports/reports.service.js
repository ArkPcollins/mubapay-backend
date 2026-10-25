'use strict';
/**
 * Financial and operational reporting. Financial reports are derived from the
 * ledger and clearly separate: settled revenue, customer liabilities, savings
 * liabilities, pending funding/withdrawals, seller obligations, refund
 * liabilities, platform fees and reconciliation differences. Transaction
 * VOLUME is reported separately and never presented as revenue.
 */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { mongoose } = require('../../lib/db');
const { LedgerAccount, LedgerEntry, LedgerTransaction } = require('../ledger/ledger.models');
const { PaymentAttempt } = require('../payments/payment.models');
const { Withdrawal, Transfer } = require('../wallet/wallet.models');
const { User } = require('../users/user.model');
const { Order, Product, DeliveryRequest, RefundRequest, Dispute, SellerSettlement } = require('../marketplace/marketplace.models');
const { Property, ViewingAppointment } = require('../realestate/realestate.models');
const { SavingsContribution } = require('../savings/savings.models');
const { ReconciliationException } = require('../reconciliation/reconciliation.service');
const { ApprovalRequest } = require('../approvals/approvals');
const { LoginAttempt } = require('../auth/auth.models');
const ledger = require('../ledger/ledger.service');
const metrics = require('../../lib/metrics');
const infra = require('../../infra');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const { koboToNairaString } = require('../../lib/money');
const { E } = require('../../lib/errors');

const { Schema } = mongoose;
const reportRunSchema = new Schema({ type: String, period: String, from: Date, to: Date, data: Schema.Types.Mixed, generatedBy: { type: Schema.Types.ObjectId, ref: 'User' }, scheduled: Boolean }, { timestamps: true, minimize: false });
reportRunSchema.index({ type: 1, createdAt: -1 });
const ReportRun = mongoose.models.ReportRun || mongoose.model('ReportRun', reportRunSchema);

const range = (from, to) => ({ from: from ? new Date(from) : new Date(Date.now() - 30 * 864e5), to: to ? new Date(to) : new Date() });

async function sumBalances(match) {
  const r = await LedgerAccount.aggregate([{ $match: match }, { $group: { _id: null, t: { $sum: '$balance' } } }]);
  return r[0]?.t || 0;
}

async function creditsTo(codes, from, to) {
  const accs = await LedgerAccount.find({ code: { $in: codes } }, { _id: 1, code: 1 }).lean();
  const r = await LedgerEntry.aggregate([
    { $match: { accountId: { $in: accs.map((a) => a._id) }, postedAt: { $gte: from, $lte: to } } },
    { $group: { _id: '$accountCode', credits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } }, debits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } } } },
  ]);
  return Object.fromEntries(r.map((x) => [x._id, x.credits - x.debits]));
}

async function volumeByType(types, from, to) {
  const r = await LedgerTransaction.aggregate([{ $match: { type: { $in: types }, postedAt: { $gte: from, $lte: to } } }, { $group: { _id: '$type', total: { $sum: '$totalKobo' }, count: { $sum: 1 } } }]);
  return Object.fromEntries(r.map((x) => [x._id, { totalKobo: x.total, count: x.count }]));
}

async function financialSummary({ from, to } = {}) {
  const w = range(from, to);
  const S = ledger.SYS;
  const revenueCodes = [S.REVENUE_COMMISSION, S.REVENUE_SALES, S.REVENUE_VIEWING, S.REVENUE_PENALTY, S.REVENUE_FEES, S.REVENUE_PROMOTION];
  const [revenue, providerFees, walletLiab, holdLiab, savingsLiab, sellerPayable, orderClearing, viewingClearing, refundPayable, deliveryPayable, pendingFunding, pendingWithdrawals, pendingRefunds, recon, volume] = await Promise.all([
    creditsTo(revenueCodes, w.from, w.to),
    LedgerEntry.aggregate([{ $match: { accountCode: S.PROVIDER_FEES, postedAt: { $gte: w.from, $lte: w.to } } }, { $group: { _id: null, d: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } }, c: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } } } }]),
    sumBalances({ purpose: 'user_wallet' }),
    sumBalances({ purpose: 'user_hold' }),
    sumBalances({ purpose: 'user_savings' }),
    sumBalances({ purpose: 'user_seller_payable' }),
    sumBalances({ code: S.ORDER_CLEARING }),
    sumBalances({ code: S.VIEWING_CLEARING }),
    sumBalances({ code: S.REFUND_PAYABLE }),
    sumBalances({ code: S.DELIVERY_PAYABLE }),
    PaymentAttempt.aggregate([{ $match: { status: { $in: ['pending', 'uncertain'] }, fulfilledAt: null } }, { $group: { _id: null, t: { $sum: '$amountKobo' }, n: { $sum: 1 } } }]),
    Withdrawal.aggregate([{ $match: { status: { $in: ['pending_review', 'approved', 'payout_processing', 'payout_uncertain', 'manual_payout_pending'] } } }, { $group: { _id: null, t: { $sum: '$amountKobo' }, n: { $sum: 1 } } }]),
    RefundRequest.aggregate([{ $match: { status: { $in: ['pending_review', 'approved', 'processing'] } } }, { $group: { _id: null, t: { $sum: '$amountKobo' }, n: { $sum: 1 } } }]),
    ReconciliationException.aggregate([{ $match: { status: { $in: ['open', 'investigating'] } } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    volumeByType(['wallet_funding', 'transfer', 'withdrawal_payout', 'order_payment', 'savings_deposit', 'savings_contribution_card', 'viewing_fee_payment'], w.from, w.to),
  ]);
  const settledRevenueKobo = Object.values(revenue).reduce((a, b) => a + b, 0);
  return {
    period: w,
    settledRevenue: { totalKobo: settledRevenueKobo, byStream: revenue, note: 'Recognised only when the underlying event completed (e.g. order settled, fee released, penalty applied).' },
    platformFeesKobo: revenue[S.REVENUE_FEES] || 0,
    providerFeesExpenseKobo: (providerFees[0]?.d || 0) - (providerFees[0]?.c || 0),
    liabilities: {
      customerWalletsKobo: walletLiab,
      reservedForWithdrawalsKobo: holdLiab,
      savingsKobo: savingsLiab,
      sellerSettlementObligationsKobo: sellerPayable,
      buyerFundsAwaitingFulfilmentKobo: orderClearing,
      viewingFeesHeldKobo: viewingClearing,
      refundsPayableToCardsKobo: refundPayable,
      deliveryFeesPayableKobo: deliveryPayable,
    },
    pending: {
      fundingUnconfirmed: { totalKobo: pendingFunding[0]?.t || 0, count: pendingFunding[0]?.n || 0 },
      withdrawals: { totalKobo: pendingWithdrawals[0]?.t || 0, count: pendingWithdrawals[0]?.n || 0 },
      refundsUnderReview: { totalKobo: pendingRefunds[0]?.t || 0, count: pendingRefunds[0]?.n || 0 },
    },
    reconciliationDifferences: { open: recon.reduce((a, r) => a + r.n, 0), byType: Object.fromEntries(recon.map((r) => [r._id, r.n])) },
    transactionVolume: { byType: volume, note: 'Volume is money moved on behalf of customers. It is NOT platform revenue.' },
  };
}

async function operationalSummary({ from, to } = {}) {
  const w = range(from, to);
  const between = { $gte: w.from, $lte: w.to };
  const [newUsers, totalUsers, activeLogins, orders, orderSales, topProducts, propsPublished, propsPending, viewings, deliveries, refunds, disputes, settlements, approvals, queue, savingsContrib, growth] = await Promise.all([
    User.countDocuments({ createdAt: between }),
    User.countDocuments({ status: { $ne: 'closed' } }),
    LoginAttempt.distinct('emailHash', { success: true, at: between }).then((x) => x.length),
    Order.aggregate([{ $match: { createdAt: between } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { paidAt: between } }, { $group: { _id: '$sellerKind', gmvKobo: { $sum: '$totalKobo' }, n: { $sum: 1 } } }]),
    Product.find({ status: 'published' }, { title: 1, soldCount: 1, viewCount: 1, priceKobo: 1, kind: 1 }).sort({ soldCount: -1 }).limit(10).lean(),
    Property.countDocuments({ status: 'published' }),
    Property.countDocuments({ status: 'pending_review' }),
    ViewingAppointment.aggregate([{ $match: { createdAt: between } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    DeliveryRequest.aggregate([{ $match: { createdAt: between } }, { $group: { _id: { provider: '$provider', status: '$status' }, n: { $sum: 1 } } }]),
    RefundRequest.aggregate([{ $match: { createdAt: between } }, { $group: { _id: '$status', n: { $sum: 1 }, t: { $sum: '$amountKobo' } } }]),
    Dispute.aggregate([{ $match: { createdAt: between } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    SellerSettlement.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, t: { $sum: '$netKobo' } } }]),
    ApprovalRequest.countDocuments({ status: 'pending' }),
    infra.queue.stats().catch((e) => ({ error: e.message })),
    SavingsContribution.aggregate([{ $match: { createdAt: between } }, { $group: { _id: '$status', n: { $sum: 1 }, t: { $sum: '$amountKobo' } } }]),
    User.aggregate([{ $match: { createdAt: between } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+01:00' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);
  const deliveredOk = deliveries.filter((d) => d._id.status === 'delivered').reduce((a, d) => a + d.n, 0);
  const deliveredFail = deliveries.filter((d) => d._id.status === 'failed').reduce((a, d) => a + d.n, 0);
  return {
    period: w,
    users: { new: newUsers, total: totalUsers, activeSignIns: activeLogins, growthByDay: growth.map((g) => ({ date: g._id, count: g.n })) },
    marketplace: { ordersByStatus: Object.fromEntries(orders.map((o) => [o._id, o.n])), grossMerchandiseValue: salesBy(orderSales), topProducts },
    savings: { contributionsByStatus: Object.fromEntries(savingsContrib.map((s) => [s._id, { count: s.n, totalKobo: s.t }])) },
    realEstate: { published: propsPublished, pendingReview: propsPending, viewingsByStatus: Object.fromEntries(viewings.map((v) => [v._id, v.n])) },
    delivery: { byProviderStatus: deliveries.map((d) => ({ ...d._id, count: d.n })), successRate: deliveredOk + deliveredFail ? deliveredOk / (deliveredOk + deliveredFail) : null },
    refunds: Object.fromEntries(refunds.map((r) => [r._id, { count: r.n, totalKobo: r.t }])),
    disputes: Object.fromEntries(disputes.map((d) => [d._id, d.n])),
    sellerSettlements: Object.fromEntries(settlements.map((s) => [s._id, { count: s.n, totalKobo: s.t }])),
    pendingApprovals: approvals,
    jobs: queue,
    system: metrics.snapshot(),
  };
}

function salesBy(rows) {
  return Object.fromEntries(rows.map((r) => [r._id, { totalKobo: r.gmvKobo, orders: r.n, note: 'GMV is customer spend, not revenue' }]));
}

/** Drill-down into authorised underlying records. */
async function drilldown({ metric, from, to, page = 1, limit = 50 }) {
  const w = range(from, to);
  const skip = (page - 1) * limit;
  if (metric.startsWith('account:')) {
    const code = metric.slice(8);
    const acc = await LedgerAccount.findOne({ code }).lean();
    if (!acc) throw E.notFound('Account');
    const rows = await LedgerEntry.find({ accountId: acc._id, postedAt: { $gte: w.from, $lte: w.to } }).sort({ postedAt: -1 }).skip(skip).limit(limit).lean();
    return { account: { code: acc.code, name: acc.name, balanceKobo: acc.balance }, items: rows };
  }
  if (metric === 'pending_withdrawals') return { items: await Withdrawal.find({ status: { $in: ['pending_review', 'approved', 'payout_processing', 'payout_uncertain', 'manual_payout_pending'] } }).sort({ createdAt: 1 }).skip(skip).limit(limit).lean() };
  if (metric === 'pending_funding') return { items: await PaymentAttempt.find({ status: { $in: ['pending', 'uncertain'] }, fulfilledAt: null }).sort({ createdAt: 1 }).skip(skip).limit(limit).lean() };
  if (metric === 'reconciliation') return { items: await ReconciliationException.find({ status: { $in: ['open', 'investigating'] } }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean() };
  if (metric === 'transfers') return { items: await Transfer.find({ createdAt: { $gte: w.from, $lte: w.to } }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean() };
  if (metric === 'refunds') return { items: await RefundRequest.find({ createdAt: { $gte: w.from, $lte: w.to } }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean() };
  if (metric === 'settlements') return { items: await SellerSettlement.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean() };
  throw E.badRequest('Unknown metric');
}

// ---------------------------------------------------------------- exports
function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) flatten(v, key, out);
    else out.push([key, Array.isArray(v) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : v]);
  }
  return out;
}

function toCsv(rows) {
  const escCell = (v) => {
    const s = v == null ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // CSV injection protection
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `\uFEFF${rows.map((r) => r.map(escCell).join(',')).join('\r\n')}`; // BOM → Excel-compatible UTF-8
}

async function toXlsx(title, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 30));
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => { c.width = 28; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(title, rows) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(16).text(`MubaPay — ${title}`);
    doc.moveDown(0.3).fontSize(9).fillColor('#555').text(`Generated ${new Date().toISOString()}`);
    doc.moveDown().fillColor('#000').fontSize(9);
    for (const r of rows) doc.text(r.map((c) => (c == null ? '' : String(c))).join('   |   '));
    doc.end();
  });
}

/** Rows for an export; money columns rendered in naira for readability alongside kobo. */
async function rowsFor(type, q) {
  if (type === 'financial') {
    const s = await financialSummary(q);
    return [['Metric', 'Value', 'Naira'], ...flatten(s).map(([k, v]) => [k, v, /Kobo$/.test(k) && typeof v === 'number' ? koboToNairaString(v) : ''])];
  }
  if (type === 'operational') return [['Metric', 'Value'], ...flatten(await operationalSummary(q))];
  if (type === 'ledger') {
    const w = range(q.from, q.to);
    const rows = await LedgerTransaction.find({ postedAt: { $gte: w.from, $lte: w.to } }).sort({ postedAt: 1 }).limit(50000).lean();
    return [['Posted at', 'Reference', 'Type', 'Total (kobo)', 'Total (₦)', 'Description'], ...rows.map((t) => [t.postedAt.toISOString(), t.reference, t.type, t.totalKobo, koboToNairaString(t.totalKobo), t.description])];
  }
  if (type === 'withdrawals') {
    const rows = await Withdrawal.find({}).sort({ createdAt: -1 }).limit(20000).lean();
    return [['Created', 'Reference', 'User', 'Amount (kobo)', 'Status', 'Method'], ...rows.map((w) => [w.createdAt.toISOString(), w.reference, String(w.userId), w.amountKobo, w.status, w.payoutMethod || ''])];
  }
  throw E.badRequest('Unknown report type');
}

async function exportReport(staff, type, format, q, req) {
  const rows = await rowsFor(type, q);
  await audit.fromReq(req, { action: 'report.exported', category: 'export', targetType: 'report', targetId: type, sensitiveRead: true, metadata: { format, from: q.from, to: q.to, rows: rows.length - 1 } });
  const name = `mubapay-${type}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') return { body: Buffer.from(toCsv(rows)), contentType: 'text/csv; charset=utf-8', filename: `${name}.csv` };
  if (format === 'xlsx') return { body: await toXlsx(type, rows), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${name}.xlsx` };
  if (format === 'pdf') return { body: await toPdf(`${type} report`, rows), contentType: 'application/pdf', filename: `${name}.pdf` };
  throw E.badRequest('format must be csv, xlsx or pdf');
}

/** Scheduled daily / weekly / monthly reports (stored + staff notified). */
async function runScheduled(period) {
  const to = new Date();
  const from = new Date(to.getTime() - { daily: 1, weekly: 7, monthly: 30 }[period] * 864e5);
  const [fin, ops] = await Promise.all([financialSummary({ from, to }), operationalSummary({ from, to })]);
  const run = await ReportRun.create({ type: 'combined', period, from, to, data: { financial: fin, operational: ops }, scheduled: true });
  await notifications.notifyStaff('reports.view', { category: 'system', type: 'scheduled_report', title: `${period[0].toUpperCase()}${period.slice(1)} report ready`, body: `Settled revenue ${koboToNairaString(fin.settledRevenue.totalKobo)}; ${fin.reconciliationDifferences.open} open reconciliation items.`, link: `/admin/reports/runs/${run._id}` });
  return { id: String(run._id) };
}

async function listRuns() {
  return ReportRun.find({}, { data: 0 }).sort({ createdAt: -1 }).limit(100).lean();
}
async function getRun(id) {
  const r = await ReportRun.findById(id).lean();
  if (!r) throw E.notFound('Report');
  return r;
}

module.exports = { financialSummary, operationalSummary, drilldown, exportReport, runScheduled, listRuns, getRun, toCsv, toXlsx, toPdf, ReportRun };
