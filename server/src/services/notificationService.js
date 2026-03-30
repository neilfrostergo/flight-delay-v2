'use strict';

/**
 * Customer notification service — tenant-branded transactional emails.
 *
 * POC: Nodemailer → Mailtrap/Brevo sandbox (emails caught, not delivered).
 * Production: swap createTransport() for SendGrid / AWS SES / your SMTP relay.
 */

const nodemailer = require('nodemailer');
const { query }  = require('../db/connection');
const config     = require('../config');

const PLATFORM_NAME = 'Flight Delay Protection';
const FROM_ADDRESS  = `"${PLATFORM_NAME}" <noreply@platform.co.uk>`;

// ── Transport ─────────────────────────────────────────────────────────────────
// PRODUCTION: replace this function body with your production mail transport
function createTransport() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
}

// ── HTML builder (tenant-branded) ─────────────────────────────────────────────
function buildEmailHtml({ heading, subheading, bodyLines, policyNumber, tenant, badgeLabel, badgeColor }) {
  const brandColor  = tenant?.primary_colour || '#1a56db';
  const companyName = tenant?.name || PLATFORM_NAME;

  const rows = bodyLines.map((l) =>
    `<tr><td style="padding:6px 0;color:#374151;font-size:15px;line-height:1.6;">${l}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr>
          <td style="background:${brandColor};padding:28px 36px;">
            <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">${companyName}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:2px;">Flight Delay Protection</div>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 36px 0;">
            <span style="display:inline-block;background:${badgeColor || '#dcfce7'};color:#ffffff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;padding:4px 14px;border-radius:20px;">${badgeLabel}</span>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 36px 0;">
            <div style="font-size:24px;font-weight:800;color:#1a1a2e;line-height:1.3;">${heading}</div>
            <div style="font-size:15px;color:#6b7280;margin-top:6px;">${subheading}</div>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 36px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 36px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border-radius:8px;border-left:4px solid ${brandColor};">
              <tr>
                <td style="padding:14px 18px;">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#6b7280;">Policy Number</div>
                  <div style="font-size:16px;font-weight:700;color:${brandColor};font-family:monospace;margin-top:4px;">${policyNumber}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 36px;border-top:1px solid #f3f4f6;margin-top:28px;">
            <div style="font-size:12px;color:#9ca3af;line-height:1.7;">
              This is an automated notification from ${companyName}.<br>
              ${tenant?.support_email ? `If you have questions, contact us at ${tenant.support_email}` : ''}
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send registration confirmation ────────────────────────────────────────────
async function sendRegistrationConfirmation(registration, flights, tenant) {
  const flightList = flights.map(
    (f) => `• ${f.flight_number} — ${f.dep_iata || ''} → ${f.arr_iata || ''} on ${f.dep_date}`
  ).join('<br>');

  const payoutStr = `£${(registration.payout_pence / 100).toFixed(0)}`;
  const subject = `Your flight protection is registered — ${tenant?.name || PLATFORM_NAME}`;

  const html = buildEmailHtml({
    heading:     'Your flights are registered',
    subheading:  `We'll watch your flights and pay you automatically if there's a delay.`,
    bodyLines: [
      `Hi ${registration.first_name},`,
      `Your flight delay protection is now active. Here are your registered flights:<br><br>${flightList}`,
      `If any flight is delayed beyond the threshold or cancelled, <strong>${payoutStr}</strong> will be automatically transferred to your registered bank account.`,
      `No action is required from you.`,
    ],
    policyNumber: registration.policy_number,
    tenant,
    badgeLabel: 'Registration Confirmed',
    badgeColor: '#1a56db',
  });

  const text = `Hi ${registration.first_name},\n\nYour flight delay protection is registered. Policy: ${registration.policy_number}\n\n— ${tenant?.name || PLATFORM_NAME}`;

  await _send({ registrationId: registration.id, email: registration.email }, subject, html, text, null, null, null, tenant);
}

// ── Send payout notification (delay or cancellation) ─────────────────────────
async function sendPayoutNotification(registration, flightReg, payment, tenant, reason) {
  const payoutStr = `£${(payment.amount_pence / 100).toFixed(0)}`;
  const isCancelled = reason === 'cancellation';

  const subject = isCancelled
    ? `Payout triggered — ${flightReg.flight_number} has been cancelled`
    : `Payout triggered — ${flightReg.flight_number} is delayed`;

  const html = buildEmailHtml({
    heading:    `Your ${payoutStr} payout is on its way`,
    subheading: isCancelled
      ? `Flight ${flightReg.flight_number} has been cancelled`
      : `Flight ${flightReg.flight_number} has been delayed`,
    bodyLines: [
      `Hi ${registration.first_name},`,
      isCancelled
        ? `Flight <strong>${flightReg.flight_number}</strong> (${flightReg.dep_iata || ''} → ${flightReg.arr_iata || ''}) on <strong>${flightReg.dep_date}</strong> has been <strong>cancelled</strong>.`
        : `Flight <strong>${flightReg.flight_number}</strong> (${flightReg.dep_iata || ''} → ${flightReg.arr_iata || ''}) on <strong>${flightReg.dep_date}</strong> has been significantly delayed.`,
      `Your <strong>${payoutStr} payout</strong> is being transferred to your registered bank account.`,
      payment.modulr_reference ? `Payment reference: <strong>${payment.modulr_reference}</strong>` : '',
    ].filter(Boolean),
    policyNumber: registration.policy_number,
    tenant,
    badgeLabel: isCancelled ? 'Flight Cancelled — Payout Triggered' : 'Payout Triggered',
    badgeColor: isCancelled ? '#dc2626' : '#16a34a',
  });

  const text = `Hi ${registration.first_name},\n\nFlight ${flightReg.flight_number} ${isCancelled ? 'has been cancelled' : 'has been delayed'}.\n\nYour ${payoutStr} payout is being transferred to your bank account.\n\nPolicy: ${registration.policy_number}\n\n— ${tenant?.name || PLATFORM_NAME}`;

  await _send(
    { registrationId: registration.id, email: registration.email },
    subject, html, text,
    flightReg.id, payment.flight_event_id, payment.id,
    tenant
  );
}

// ── Shared CTA button builder ─────────────────────────────────────────────────
function ctaButton(url, label, brandColor) {
  return `<tr><td style="padding:28px 0 8px;">
    <a href="${url}" style="display:inline-block;background:${brandColor};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:8px;">${label}</a>
  </td></tr>`;
}

function docTip(brandColor) {
  return `<tr><td style="padding:16px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border-radius:8px;border-left:4px solid #f59e0b;">
      <tr><td style="padding:14px 18px;">
        <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px;">💡 Quickest way to register</div>
        <div style="font-size:13px;color:#78350f;line-height:1.6;">Upload your <strong>flight booking confirmation</strong> or <strong>e-ticket</strong> — we'll read your flight details automatically. <em>Note: boarding passes are only issued within 24 hours of departure, so please use your booking confirmation instead.</em></div>
      </td></tr>
    </table>
  </td></tr>`;
}

// ── Outreach: single trip ─────────────────────────────────────────────────────
async function sendSingleTripOutreach({ firstName, email, policyNumber, tokenUrl, tenant }) {
  const brandColor = tenant?.primary_colour || '#1a56db';
  const companyName = tenant?.name || PLATFORM_NAME;
  const subject = `Register your flight now — ${companyName} Flight Delay Protection`;

  const html = buildEmailHtml({
    heading:    'Register your flight before you fly',
    subheading: `You're covered — make sure we know your flight details at least 24 hours before departure.`,
    bodyLines: [
      `Hi ${firstName},`,
      `Your <strong>${companyName}</strong> travel insurance policy includes flight delay protection. To make sure you receive an automatic payout if your flight is delayed or cancelled, you need to <strong>register your flight at least 24 hours before departure</strong>.`,
      `It only takes a couple of minutes. Click the button below to get started — your policy details will be pre-filled.`,
      `<table width="100%" cellpadding="0" cellspacing="0">${ctaButton(tokenUrl, 'Register My Flight →', brandColor)}${docTip(brandColor)}</table>`,
      `<strong>Important:</strong> Registration closes 24 hours before your scheduled departure time. Don't miss the window!`,
    ],
    policyNumber,
    tenant,
    badgeLabel: 'Action Required',
    badgeColor: '#f59e0b',
  });

  const text = `Hi ${firstName},\n\nRegister your flight at least 24 hours before departure to activate your delay protection.\n\n${tokenUrl}\n\nPolicy: ${policyNumber}\n\n— ${companyName}`;
  await _send({ registrationId: null, email }, subject, html, text, null, null, null, tenant);
}

// ── Outreach: return trip ─────────────────────────────────────────────────────
async function sendReturnTripOutreach({ firstName, email, policyNumber, tokenUrl, tenant }) {
  const brandColor = tenant?.primary_colour || '#1a56db';
  const companyName = tenant?.name || PLATFORM_NAME;
  const subject = `Register your outbound & return flights — ${companyName} Flight Delay Protection`;

  const html = buildEmailHtml({
    heading:    'Register both your flights before you travel',
    subheading: `Your cover applies to both legs of your journey — don't forget your return flight.`,
    bodyLines: [
      `Hi ${firstName},`,
      `Your <strong>${companyName}</strong> travel insurance policy covers both your <strong>outbound and return flights</strong>. To ensure you receive an automatic payout on either leg if there's a significant delay or cancellation, you need to <strong>register both flights at least 24 hours before each departure</strong>.`,
      `Click the button below to register — you can add both flights in one go and your policy details will be pre-filled.`,
      `<table width="100%" cellpadding="0" cellspacing="0">${ctaButton(tokenUrl, 'Register My Flights →', brandColor)}${docTip(brandColor)}</table>`,
      `<strong>Remember:</strong> You need to register <em>each</em> flight at least 24 hours before it departs. We recommend registering both at the same time as soon as you receive this email.`,
    ],
    policyNumber,
    tenant,
    badgeLabel: 'Action Required',
    badgeColor: '#f59e0b',
  });

  const text = `Hi ${firstName},\n\nRegister both your outbound and return flights at least 24 hours before each departure.\n\n${tokenUrl}\n\nPolicy: ${policyNumber}\n\n— ${companyName}`;
  await _send({ registrationId: null, email }, subject, html, text, null, null, null, tenant);
}

// ── Outreach: annual multi-trip ───────────────────────────────────────────────
async function sendAnnualMultiTripOutreach({ firstName, email, policyNumber, tokenUrl, tenant }) {
  const brandColor = tenant?.primary_colour || '#1a56db';
  const companyName = tenant?.name || PLATFORM_NAME;
  const subject = `Register your flights throughout the year — ${companyName} Flight Delay Protection`;

  const html = buildEmailHtml({
    heading:    'Your annual policy covers every trip — register each flight before you fly',
    subheading: `Each time you travel, remember to register your flights at least 24 hours before departure.`,
    bodyLines: [
      `Hi ${firstName},`,
      `Your <strong>${companyName} Annual Multi-Trip</strong> policy includes flight delay protection on every trip you take this year. To receive an automatic payout whenever a covered flight is delayed or cancelled, you must <strong>register each flight at least 24 hours before it departs</strong>.`,
      `You can register as many flights as you like — use the same link each time you book a new trip.`,
      `<table width="100%" cellpadding="0" cellspacing="0">${ctaButton(tokenUrl, 'Register a Flight →', brandColor)}${docTip(brandColor)}</table>`,
      `<strong>How it works:</strong><br>
       1. Click the link above before each trip<br>
       2. Upload your booking confirmation — we'll read your flight details automatically<br>
       3. We monitor your flights and pay you automatically if anything goes wrong<br>
       4. Repeat for every trip throughout your policy year`,
      `<strong>Don't leave it to the last minute</strong> — registration must be completed at least 24 hours before departure. Boarding passes are only issued within 24 hours of departure, so please use your <strong>booking confirmation or e-ticket</strong> instead.`,
    ],
    policyNumber,
    tenant,
    badgeLabel: 'Annual Multi-Trip Policy',
    badgeColor: brandColor,
  });

  const text = `Hi ${firstName},\n\nYour Annual Multi-Trip policy covers every flight this year. Register each flight at least 24 hours before departure.\n\n${tokenUrl}\n\nPolicy: ${policyNumber}\n\n— ${companyName}`;
  await _send({ registrationId: null, email }, subject, html, text, null, null, null, tenant);
}

// ── Internal send + DB log ────────────────────────────────────────────────────
async function _send(ctx, subject, html, text, flightRegId, flightEventId, paymentId, tenant) {
  const notifResult = await query(
    `INSERT INTO notifications
       (tenant_id, registration_id, flight_registration_id, flight_event_id, payment_id,
        channel, recipient, subject, status)
     VALUES ($1,$2,$3,$4,$5,'email',$6,$7,'pending')
     RETURNING id`,
    [
      tenant?.id || null,
      ctx.registrationId,
      flightRegId || null,
      flightEventId || null,
      paymentId || null,
      ctx.email,
      subject,
    ]
  );
  const notifId = notifResult.rows[0].id;

  try {
    const transport = createTransport();
    await transport.sendMail({ from: FROM_ADDRESS, to: ctx.email, subject, html, text });
    await query(`UPDATE notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`, [notifId]);
    console.log(`[notifications] Email sent to ${ctx.email}`);
  } catch (err) {
    await query(
      `UPDATE notifications SET status = 'failed', error_message = $1 WHERE id = $2`,
      [err.message, notifId]
    );
    console.error(`[notifications] Failed to send to ${ctx.email}:`, err.message);
  }
}

module.exports = {
  sendRegistrationConfirmation,
  sendPayoutNotification,
  sendSingleTripOutreach,
  sendReturnTripOutreach,
  sendAnnualMultiTripOutreach,
};
