'use strict';
const config = require('../../config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, bodyHtml, cta, unsubscribeUrl) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:Segoe UI,Arial,sans-serif;color:#10231d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:28px">
<tr><td style="font-size:20px;font-weight:700;color:#0E7C66">MubaPay</td></tr>
<tr><td style="padding-top:16px;font-size:18px;font-weight:600">${esc(title)}</td></tr>
<tr><td style="padding-top:12px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
${cta ? `<tr><td style="padding-top:20px"><a href="${esc(cta.url)}" style="background:#0E7C66;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">${esc(cta.label)}</a></td></tr>` : ''}
<tr><td style="padding-top:28px;font-size:12px;color:#5b6b66">If you did not expect this email, contact ${esc(config.SUPPORT_EMAIL)}. MubaPay will never ask for your password or one-time codes.${unsubscribeUrl ? `<br/><br/>You receive this because you opted in to offers and news. <a href="${esc(unsubscribeUrl)}" style="color:#5b6b66">Unsubscribe</a>.` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Render an email from a notification document. */
function render(n) {
  const url = n.link ? (n.link.startsWith('http') ? n.link : `${config.FRONTEND_URL}${n.link}`) : null;
  const custom = TEMPLATES[n.email?.template];
  if (custom) return custom(n, url);
  const body = `<p>${esc(n.body || '')}</p>`;
  const unsub = n.category === 'marketing' ? `${config.FRONTEND_URL}/unsubscribe?token=${encodeURIComponent(require('../privacy/privacy.service').unsubscribeToken(String(n.userId)))}` : null;
  return { subject: n.title, html: layout(n.title, body, url ? { url, label: 'Open MubaPay' } : null, unsub), text: `${n.title}\n\n${n.body || ''}${url ? `\n\n${url}` : ''}${unsub ? `\n\nUnsubscribe: ${unsub}` : ''}` };
}

const TEMPLATES = {
  email_verify: (n) => {
    const url = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(n.data.token)}`;
    return { subject: 'Verify your MubaPay email', html: layout('Confirm your email address', '<p>Welcome to MubaPay. Confirm your email address to continue setting up your account. This link expires in 24 hours.</p>', { url, label: 'Verify email' }), text: `Verify your email: ${url}` };
  },
  password_reset: (n) => {
    const url = `${config.FRONTEND_URL}/reset-password?token=${encodeURIComponent(n.data.token)}`;
    return { subject: 'Reset your MubaPay password', html: layout('Password reset requested', '<p>Use the button below to choose a new password. The link expires in 30 minutes. If you did not request this, you can ignore this email — your password will not change.</p>', { url, label: 'Reset password' }), text: `Reset your password: ${url}` };
  },
  login_alert: (n) => ({
    subject: 'New sign-in to your MubaPay account',
    html: layout('New sign-in detected', `<p>Your account was signed in from a new device.</p><p>IP: ${esc(n.data.ip)}<br/>Device: ${esc(n.data.userAgent)}<br/>Time: ${esc(new Date(n.createdAt || Date.now()).toUTCString())}</p><p>If this wasn't you, reset your password immediately and sign out other sessions.</p>`, { url: `${config.FRONTEND_URL}/app/settings/security`, label: 'Review security' }),
    text: `New sign-in from ${n.data.ip} (${n.data.userAgent}). If this wasn't you, reset your password.`,
  }),
};

module.exports = { render, layout, esc };
