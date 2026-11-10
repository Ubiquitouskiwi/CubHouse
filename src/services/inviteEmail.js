'use strict';

const { formatInZone } = require('../timeZone');

/**
 * The invite email: an HTML message plus a plain-text alternative.
 *
 * Built to render in Gmail, Apple Mail and Outlook: table layout, inline
 * styles, email-safe font fallbacks, and a <style> block used only for the
 * dark-mode and narrow-screen overrides (clients that drop it still get the
 * light layout). Nothing is loaded from anywhere: no images, fonts, pixels or
 * stylesheets, so opening the email tells nobody anything. The brand mark is
 * an emoji on a honey badge, echoing the bear badge in the site header.
 *
 * Content is deliberately minimal: the app name, the inviting guardian's
 * display name, the code, a join link and the expiry. No photos, no child's
 * name, no other family details.
 */

// The site's light and dark palettes (public/styles.css).
const LIGHT = {
  bg: '#f3ecdc',
  surface: '#fffaf0',
  text: '#33291f',
  muted: '#7a6a56',
  accent: '#2f6b4f',
  accentText: '#fffaf0',
  pineDeep: '#234e3a',
  honey: '#e0a53f',
  honeySoft: '#f8e9cc',
  sky: '#dcefef',
  border: '#e3d7bf',
};
const DARK = {
  bg: '#15201a',
  surface: '#1e2a22',
  text: '#ece5d6',
  muted: '#a6b0a0',
  accent: '#6fbf95',
  accentText: '#11211a',
  honey: '#e8bb63',
  honeySoft: '#33301f',
  sky: '#27404a',
  border: '#33443a',
};

const HEADING_FONT = "'Fredoka', 'Nunito', 'Trebuchet MS', 'Segoe UI', Arial, sans-serif";
const BODY_FONT = "'Nunito', 'Segoe UI', -apple-system, Helvetica, Arial, sans-serif";
const CODE_FONT = "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line of display text: no control characters, collapsed spaces. */
function oneLine(value, max = 80) {
  return Array.from(String(value === null || value === undefined ? '' : value))
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * "Fri, Nov 13, 2026, 4:46 PM EST" in the family's time zone (src/timeZone.js),
 * plus a rough "about 3 days". An email cannot know the reader's own zone, so
 * the zone is always named.
 */
function describeExpiry(expiresAt, now = Date.now(), timeZone = 'UTC') {
  const at = Date.parse(expiresAt || '');
  if (!Number.isFinite(at)) {
    return null;
  }
  const when = formatInZone(at, timeZone);
  const hours = Math.max(1, Math.round((at - now) / 3600000));
  const rough = hours >= 48 ? `about ${Math.round(hours / 24)} days` : `about ${hours} hour${hours === 1 ? '' : 's'}`;
  return { when, rough };
}

/**
 * Join link. The code rides in the URL FRAGMENT, which browsers never send to
 * the server, so it stays out of access logs and Referer headers. The
 * register page copies it into the form (prefill only; validation unchanged).
 */
function joinLink(origin, code) {
  return `${String(origin).replace(/\/+$/, '')}/register#code=${encodeURIComponent(code)}`;
}

function buildInviteEmail({ appName, origin, code, inviterName, firstName, expiresAt, timeZone = 'UTC', now = Date.now() }) {
  const app = oneLine(appName, 60) || 'Cubhouse';
  const inviter = oneLine(inviterName, 80) || 'A guardian';
  const name = oneLine(firstName, 60);
  const link = joinLink(origin, code);
  const registerUrl = `${String(origin).replace(/\/+$/, '')}/register`;
  const expiry = describeExpiry(expiresAt, now, timeZone);
  const subject = `You're invited to join ${app}`;

  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const intro = `${inviter} has invited you to join ${app}, a private family photo space.`;
  const expiryLine = expiry ? `The code works once and expires in ${expiry.rough} (${expiry.when}).` : 'The code works once.';
  const ignoreLine = "If you weren't expecting this, you can ignore it. Nothing happens unless the code is used.";

  const text = [
    greeting,
    '',
    intro,
    '',
    'Your invite code:',
    '',
    `    ${code}`,
    '',
    `Join here (the code is filled in for you): ${link}`,
    `Or open ${registerUrl} and enter the code.`,
    '',
    expiryLine,
    '',
    ignoreLine,
    '',
    `- ${app}`,
  ].join('\n');

  const e = escapeHtml;
  const L = LIGHT;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(subject)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (max-width: 600px) {
    .ch-card { width: 100% !important; }
    .ch-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .ch-code { font-size: 19px !important; letter-spacing: 0.5px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .ch-bg { background-color: ${DARK.bg} !important; }
    .ch-card { background-color: ${DARK.surface} !important; border-color: ${DARK.border} !important; }
    .ch-sky { background-color: ${DARK.sky} !important; }
    .ch-text { color: ${DARK.text} !important; }
    .ch-muted { color: ${DARK.muted} !important; }
    .ch-badge { background-color: ${DARK.honeySoft} !important; border-color: ${DARK.honey} !important; }
    .ch-codebox { background-color: ${DARK.honeySoft} !important; border-color: ${DARK.honey} !important; }
    .ch-code { color: ${DARK.text} !important; }
    .ch-btn { background-color: ${DARK.accent} !important; }
    .ch-btn a { color: ${DARK.accentText} !important; }
    .ch-link { color: ${DARK.accent} !important; }
    .ch-rule { border-top-color: ${DARK.border} !important; }
  }
</style>
</head>
<body class="ch-bg" style="margin:0;padding:0;background-color:${L.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(inviter)} invited you to ${e(app)}.</div>
<table role="presentation" class="ch-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.bg}" style="background-color:${L.bg};">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" class="ch-card" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.surface}" style="width:560px;max-width:560px;background-color:${L.surface};border:2px dashed ${L.border};border-radius:18px;border-collapse:separate;overflow:hidden;">
    <tr><td class="ch-sky ch-pad" bgcolor="${L.sky}" style="background-color:${L.sky};padding:22px 32px 18px;border-radius:16px 16px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="ch-badge" width="44" height="44" align="center" valign="middle" bgcolor="${L.honeySoft}" style="width:44px;height:44px;background-color:${L.honeySoft};border:2px solid ${L.honey};border-radius:50%;font-size:24px;line-height:44px;" aria-hidden="true">&#x1F43B;</td>
        <td class="ch-text" style="padding-left:12px;font-family:${HEADING_FONT};font-size:24px;font-weight:700;color:${L.text};letter-spacing:0.01em;">${e(app)}</td>
      </tr></table>
    </td></tr>
    <tr><td height="6" bgcolor="${L.pineDeep}" style="height:6px;line-height:6px;font-size:0;background-color:${L.pineDeep};">&nbsp;</td></tr>
    <tr><td class="ch-pad" style="padding:28px 32px 8px;">
      <h1 class="ch-text" style="margin:0 0 14px;font-family:${HEADING_FONT};font-size:24px;line-height:1.3;font-weight:700;color:${L.text};">You're invited</h1>
      <p class="ch-text" style="margin:0 0 10px;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${L.text};">${e(greeting)}</p>
      <p class="ch-text" style="margin:0 0 20px;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${L.text};"><strong>${e(inviter)}</strong> has invited you to join ${e(app)}, a private family photo space.</p>
    </td></tr>
    <tr><td class="ch-pad" style="padding:0 32px;">
      <p class="ch-muted" style="margin:0 0 8px;font-family:${BODY_FONT};font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${L.muted};">Your invite code</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="ch-codebox" align="center" bgcolor="${L.honeySoft}" style="background-color:${L.honeySoft};border:2px dashed ${L.honey};border-radius:14px;padding:18px 12px;">
          <span class="ch-code" style="font-family:${CODE_FONT};font-size:26px;line-height:1.3;font-weight:700;letter-spacing:2px;color:${L.text};-webkit-user-select:all;user-select:all;white-space:nowrap;">${e(code)}</span>
        </td>
      </tr></table>
    </td></tr>
    <tr><td align="center" class="ch-pad" style="padding:26px 32px 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="ch-btn" align="center" bgcolor="${L.accent}" style="background-color:${L.accent};border-radius:999px;border-bottom:3px solid ${L.pineDeep};">
          <a href="${e(link)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 30px;font-family:${HEADING_FONT};font-size:17px;font-weight:700;color:${L.accentText};text-decoration:none;border-radius:999px;">Join ${e(app)}</a>
        </td>
      </tr></table>
      <p class="ch-muted" style="margin:12px 0 0;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${L.muted};">The button fills in the code for you. Or open <a class="ch-link" href="${e(registerUrl)}" style="color:${L.accent};">${e(registerUrl)}</a> and enter it.</p>
    </td></tr>
    <tr><td class="ch-pad" style="padding:20px 32px 28px;">
      <p class="ch-text" style="margin:0 0 14px;font-family:${BODY_FONT};font-size:15px;line-height:1.6;color:${L.text};">${e(expiryLine)}</p>
      <p class="ch-muted ch-rule" style="margin:0;padding-top:14px;border-top:2px dashed ${L.border};font-family:${BODY_FONT};font-size:13px;line-height:1.6;color:${L.muted};">${e(ignoreLine)}</p>
    </td></tr>
  </table>
  <p class="ch-muted" style="margin:16px 0 0;font-family:${BODY_FONT};font-size:12px;color:${L.muted};">Sent by ${e(app)} on behalf of ${e(inviter)}.</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html, link };
}

module.exports = { buildInviteEmail, joinLink, describeExpiry, escapeHtml };
