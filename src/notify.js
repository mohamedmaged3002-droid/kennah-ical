// Email notification for Kennah price changes (Gmail SMTP via nodemailer).
// Gated on SMTP_USER/SMTP_PASS — if unset it is SKIPPED, not an error, so the
// watch can be merged and run before the secrets exist.
// NOTIFY_EMAIL may be a comma-separated list.
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

async function notifyEmail(subject, text, attachments = []) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.NOTIFY_EMAIL || user;
  if (!user || !pass) { console.log('Email: skipped (SMTP_USER/SMTP_PASS not set)'); return false; }
  if (!nodemailer) { console.log('Email: skipped (nodemailer not installed)'); return false; }
  try {
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    await t.sendMail({ from: `BlueKeys Pricing <${user}>`, to, subject, text, attachments });
    console.log(`Email: sent to ${to}${attachments.length ? ` (+${attachments.length} attachment)` : ''}`);
    return true;
  } catch (e) { console.log('Email: error', String(e).slice(0, 200)); return false; }
}
module.exports = { notifyEmail };
