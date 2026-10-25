'use strict';
/**
 * Initial legal document TEMPLATES. They are implementation deliverables only
 * and MUST be reviewed and adapted by qualified Nigerian legal counsel (and,
 * where relevant, compliance advisers) before launch. They deliberately make
 * no claims of licences, regulatory approvals, deposit insurance, guarantees
 * or protections that MubaPay has not obtained.
 */
const NOTICE = '> **Draft template — not yet reviewed by a qualified legal professional.** This document must be reviewed and approved before MubaPay launches to the public. Bracketed items must be completed.\n\n';

const docs = {
  terms_of_service: ['Terms of Service', `${NOTICE}# Terms of Service

These terms govern your use of MubaPay, operated by [LEGAL ENTITY NAME], [REGISTERED ADDRESS], RC [NUMBER] ("MubaPay", "we").

## 1. Eligibility and accounts
You must be at least 18 years old and able to enter a binding contract. One person may hold one account; the same account can use several features (shopping, selling fairly-used items, listing property as an approved landlord or agent). Keep your password and one-time codes private. We will never ask for them.

## 2. Verification
Some features require verification (email, phone and identity). We may limit, pause or decline features while verification is pending or if information cannot be confirmed.

## 3. Financial services
Wallet, savings and payment features are provided only where the required regulatory authorisation or licensed partner arrangement is in place: [DESCRIBE LICENCE OR PARTNER ARRANGEMENT]. Until then those features may be unavailable. Payments are processed by our payment partners (currently Paystack) under their terms.

## 4. Acceptable use
You must not use MubaPay for fraud, money laundering, prohibited items, harassment, or to move transactions off-platform to avoid protections.

## 5. Fees
Fees are disclosed before you confirm a transaction. Fee changes apply only to transactions made after the change takes effect.

## 6. Suspension and closure
We may restrict or suspend accounts to protect users or comply with law. You may close your account once no obligations remain (balances, active savings, pending withdrawals, open disputes or unsettled orders). Some records must be retained after closure as required by law.

## 7. Liability
[TO BE DRAFTED BY COUNSEL — limitations must comply with Nigerian consumer protection law, including the Federal Competition and Consumer Protection Act 2018.]

## 8. Disputes and governing law
These terms are governed by the laws of the Federal Republic of Nigeria. See the Dispute Resolution Policy.

## 9. Changes
We will notify you of material changes and ask you to accept them where required.`],
  privacy_policy: ['Privacy Policy', `${NOTICE}# Privacy Policy

[LEGAL ENTITY NAME] is the data controller for personal data processed through MubaPay. This policy is intended to meet the Nigeria Data Protection Act 2023 and related regulations; counsel must confirm compliance and any registration obligations with the Nigeria Data Protection Commission.

## What we collect
Account details (name, email, phone), verification information and documents, transaction and order records, delivery addresses, property listing data, messages sent through MubaPay, device and security logs.

## Why we use it (lawful bases)
To provide the services you request (contract), to verify identity and prevent fraud (legal obligation / legitimate interests), to meet legal record-keeping duties, and — only with your consent — for marketing.

## Sharing
Payment processing (Paystack), email delivery (Brevo), media hosting for public listing photos (Cloudinary), logistics partners for deliveries, mapping/geocoding (OpenStreetMap services), WhatsApp Business (if you contact us on WhatsApp), and authorities where legally required. Identity documents are stored privately and encrypted; they are never published.

## Retention
Financial, identity-verification, fraud and dispute records are retained for [RETENTION PERIOD — e.g. as required by applicable AML/CFT regulations]. Other data is deleted or anonymised when no longer needed or when you close your account.

## Your rights
Access, correction, deletion (subject to legal retention), objection, withdrawal of consent and data portability. Use Settings → Privacy to export your data, or contact [DPO EMAIL].

## Security
Encryption in transit and at rest for sensitive data, access controls, audit logging and two-factor authentication for staff.`],
  cookie_policy: ['Cookie Policy', `${NOTICE}# Cookie Policy

MubaPay uses **essential cookies only** by default: session cookies to keep you signed in securely, a security token to protect against cross-site request forgery, and your theme preference stored in your browser.

We do not use advertising or analytics tracking cookies unless you opt in. If we introduce optional analytics in future, we will ask for your consent first and you can withdraw it at any time.`],
  wallet_terms: ['Wallet and Payment Terms', `${NOTICE}# Wallet and Payment Terms

## Nature of the wallet
Your MubaPay wallet records money you have paid in and may spend on MubaPay, transfer to other MubaPay users or withdraw to your Nigerian bank account. [STATE THE LICENSED INSTITUTION / ARRANGEMENT HOLDING CUSTOMER FUNDS.] The wallet does not earn interest. [STATE WHETHER ANY DEPOSIT INSURANCE APPLIES — do not claim NDIC coverage unless it actually applies.]

## Funding
Funding is via Paystack. Your wallet is credited only after we confirm the payment with Paystack — not when you return from the payment page. Unconfirmed payments are shown as pending and are not spendable.

## Limits
Limits depend on your verification tier and are shown in the app.

## Transfers
Transfers between MubaPay users are currently free. Transfers may be held for a security review; held funds are reserved and not spendable until the review completes.

## Withdrawals
Every withdrawal is reviewed before payout. Funds are reserved while under review. A withdrawal is marked complete only after the payout is confirmed. If a payout fails or is rejected, the reserved amount is returned to your wallet.

## Errors and corrections
We correct errors with documented, approved adjustments; we never silently edit balances.`],
  savings_terms: ['Personal Savings Terms', `${NOTICE}# Personal Savings Terms

## The product
Personal savings lets you set money aside until a maturity date. **No interest is paid.** [STATE THE LICENSED INSTITUTION / ARRANGEMENT HOLDING SAVINGS FUNDS.]

## Contributions
You can contribute from your wallet or a saved card, manually or on a schedule. A failed payment is never recorded as a contribution.

## Missed scheduled contributions
If a scheduled contribution fails, we retry during the grace period shown for your plan. After that it is marked as missed. **No fee is charged for missed contributions.** After the number of consecutive missed contributions shown in your plan, the schedule is paused until you resume it.

## Early exit
If you close a plan before maturity, the early-exit penalty disclosed for your plan applies (fixed amount or percentage, never more than your balance). The exact amount is shown and must be confirmed before you exit. The terms you accepted when you enrolled continue to apply to that plan.

## Maturity
At maturity your full balance is credited to your MubaPay wallet, or sent to your bank through a withdrawal request if you chose that option.`],
  marketplace_refund_policy: ['Marketplace and Refund Policy', `${NOTICE}# Marketplace and Refund Policy

- **New products** are sold by MubaPay. **Fairly-used items** are sold by verified individual sellers and are reviewed by MubaPay before they are listed.
- Payment for an order is held until delivery or collection is confirmed and the settlement hold period passes. [CONFIRM THE LICENSED ARRANGEMENT THAT PERMITS HOLDING ORDER FUNDS.]
- You may request a refund within [7] days of delivery for items not received, damaged, not as described or wrong. Our team reviews evidence before deciding.
- Approved refunds are credited to your MubaPay wallet by default, or to the original card where available.
- Paid promotions are always labelled "Sponsored".`],
  delivery_policy: ['Delivery Policy', `${NOTICE}# Delivery Policy

- We currently deliver within the states shown at checkout (initially Anambra, Enugu and Imo).
- Delivery fees are quoted before you pay — from a logistics partner's live quote or MubaPay's published delivery rates — and you pay the confirmed fee.
- Couriers may attempt delivery up to [2] more times after a failed attempt. If delivery cannot be completed, you may cancel and receive a refund under the Marketplace and Refund Policy.
- For collection orders, show your one-time collection code only when you receive your item. Codes cannot be reused.`],
  property_viewing_policy: ['Property Viewing Policy', `${NOTICE}# Property Viewing Policy

- MubaPay helps you discover properties and arrange viewings. **MubaPay does not collect rent, deposits or purchase prices.** Never pay those to anyone through MubaPay messages; verify title and documents independently before any property transaction.
- Some landlords/agents require a disclosed viewing fee, paid through MubaPay before the viewing is confirmed.
- **Cancellations:** if the landlord/agent cancels, you get a full refund. If you cancel at least [24] hours before the viewing, you get a full refund. Later cancellations and no-shows by you are not refunded.
- If the landlord/agent does not show up, report it within [48] hours for a full refund.
- Contact details are shared only when the workflow and your privacy settings allow.`],
  prohibited_items_policy: ['Prohibited Items Policy', `${NOTICE}# Prohibited Items Policy

You may not list: weapons, ammunition and explosives; illegal drugs and drug paraphernalia; prescription medicines; stolen goods; counterfeit items; hazardous materials; human remains or body parts; live animals [subject to policy]; adult content; items that infringe intellectual property; financial instruments or currency; documents such as IDs or certificates; and anything illegal under Nigerian law. MubaPay may remove listings and restrict accounts that breach this policy.`],
  dispute_resolution: ['Dispute Resolution Policy', `${NOTICE}# Dispute Resolution Policy

1. **Talk first.** Use MubaPay messaging to resolve issues with the other party.
2. **Open a dispute** from the order or appointment page. Funds still held by MubaPay stay on hold while we review.
3. **Evidence.** Both parties can add statements. A MubaPay specialist reviews the evidence against our policies.
4. **Decision.** We may refund in full or in part, or release funds to the seller/provider. Decisions and reasons are recorded.
5. **Escalation.** If you disagree, contact [ESCALATION CONTACT]. You may also contact the Federal Competition and Consumer Protection Commission or pursue other remedies available under Nigerian law.`],
};

module.exports = { docs, NOTICE };
