#!/usr/bin/env node
// Email the Kennah price-change digest — ONLY when price-watch.js found something.
// out/change-message.json is null on a quiet day, and null means no email at all.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { notifyEmail } = require('./src/notify');

(async () => {
  const msgPath = path.join(__dirname, 'out', 'change-message.json');
  if (!fs.existsSync(msgPath)) { console.log('send-alert: no change-message.json — skipping.'); return; }
  const msg = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
  if (!msg || !msg.emailSubject) { console.log('send-alert: no changes — no email.'); return; }

  const dateStr = new Date().toISOString().slice(0, 10);
  const xlsx = path.join(__dirname, 'out', 'kennah-price-changes.xlsx');
  const attachments = fs.existsSync(xlsx)
    ? [{ filename: `Kennah price changes ${dateStr}.xlsx`, path: xlsx }]
    : [];
  if (!attachments.length) console.log('send-alert: changes sheet missing — sending text-only.');

  const ok = await notifyEmail(msg.emailSubject, msg.emailBody, attachments);
  if (!ok) process.exitCode = 1;
})().catch((e) => { console.error(String(e)); process.exit(1); });
