'use strict';
/**
 * Permission catalogue. Staff (admin) accounts receive an explicit subset.
 * Superadmins implicitly hold every permission EXCEPT where separation of
 * duties is enforced by the dual-approval engine (initiator ≠ approver).
 *
 * Viewing ≠ changing: every area has distinct ".view" and action permissions.
 */
const PERMISSIONS = {
  // Users & staff
  'users.view': 'View user accounts (limited PII)',
  'users.view_pii': 'View full personal details of users',
  'users.restrict': 'Restrict / unrestrict user accounts',
  'staff.manage': 'Create staff accounts and assign permissions (superadmin)',
  // Identity verification
  'kyc.view': 'View verification queue',
  'kyc.review': 'Approve / reject identity verification',
  'kyc.documents.view': 'Open private identity documents',
  'roles.review': 'Approve landlord / agent / seller applications',
  // Finance
  'finance.view': 'View wallets, ledger and transactions',
  'withdrawals.view': 'View withdrawal requests',
  'withdrawals.approve': 'Approve or reject withdrawals',
  'withdrawals.payout': 'Initiate payouts and confirm manual payouts',
  'finance.adjust.initiate': 'Initiate financial corrections (requires second approver)',
  'finance.adjust.approve': 'Approve financial corrections initiated by others',
  'reconciliation.view': 'View reconciliation runs and exceptions',
  'reconciliation.resolve': 'Resolve reconciliation exceptions',
  'risk.review': 'Review held / flagged transactions',
  // Savings
  'savings.view': 'View savings accounts',
  'savings.manage_plans': 'Create and edit savings plans',
  // Marketplace
  'products.manage': 'Create and manage new-product listings',
  'listings.moderate': 'Moderate used-product listings',
  'categories.manage': 'Manage product categories and prohibited rules',
  'orders.view': 'View orders',
  'orders.manage': 'Update order fulfilment status',
  'deliveries.manage': 'Manage deliveries and manual status fallbacks',
  'collections.confirm': 'Confirm customer collections (staff-assisted)',
  'refunds.view': 'View refund requests',
  'refunds.decide': 'Approve or reject refunds',
  'disputes.manage': 'Manage disputes',
  'settlements.view': 'View seller settlements',
  'settlements.release': 'Release seller settlements',
  // Real estate
  'properties.moderate': 'Review and publish property listings',
  'properties.documents.view': 'Open private property verification documents',
  'appointments.view': 'View viewing appointments',
  'appointments.manage': 'Resolve appointment disputes / no-shows',
  // Support & messaging
  'support.view': 'View assigned support tickets',
  'support.manage': 'Assign and respond to support tickets',
  'support.view_all': 'View all support tickets (supervisor)',
  'messaging.moderate': 'Investigate reports and restrict messaging',
  'notifications.manage': 'Send operational notifications / manage templates',
  // Reports & audit
  'reports.view': 'View reports',
  'reports.export': 'Export reports (audited)',
  'audit.view': 'View audit logs',
  'alerts.manage': 'Acknowledge operational alerts',
  // Platform
  'settings.view': 'View platform settings',
  'settings.manage': 'Change platform settings, fees, limits (superadmin)',
  'flags.manage': 'Toggle feature flags (superadmin)',
  'legal.manage': 'Publish legal document versions',
  'system.health': 'View detailed system health and job queues',
  'system.maintenance': 'Toggle maintenance mode',
};

/** Permissions that only superadmins may hold (cannot be granted to admins). */
const SUPERADMIN_ONLY = new Set(['staff.manage', 'settings.manage', 'flags.manage', 'system.maintenance']);

/** Suggested admin permission bundles (assignable presets). */
const ADMIN_PRESETS = {
  support_agent: ['users.view', 'support.view', 'support.manage', 'orders.view', 'appointments.view', 'refunds.view'],
  verification_officer: ['users.view', 'kyc.view', 'kyc.review', 'kyc.documents.view', 'roles.review', 'properties.documents.view'],
  moderator: ['listings.moderate', 'properties.moderate', 'messaging.moderate', 'users.view'],
  catalogue_manager: ['products.manage', 'categories.manage', 'orders.view', 'orders.manage', 'deliveries.manage', 'collections.confirm'],
  finance_officer: ['finance.view', 'withdrawals.view', 'withdrawals.approve', 'withdrawals.payout', 'reconciliation.view', 'refunds.view', 'refunds.decide', 'settlements.view', 'settlements.release', 'finance.adjust.initiate', 'risk.review'],
  finance_controller: ['finance.view', 'withdrawals.view', 'withdrawals.approve', 'finance.adjust.approve', 'reconciliation.view', 'reconciliation.resolve', 'reports.view', 'reports.export'],
  operations_lead: ['reports.view', 'audit.view', 'alerts.manage', 'system.health', 'orders.view', 'disputes.manage', 'appointments.manage', 'support.view_all'],
};

const ALL = Object.keys(PERMISSIONS);

module.exports = { PERMISSIONS, ALL_PERMISSIONS: ALL, SUPERADMIN_ONLY, ADMIN_PRESETS };
