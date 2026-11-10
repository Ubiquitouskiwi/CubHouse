'use strict';

const config = require('./config');
const { logger } = require('./logger');

/**
 * Guardian notifications: new-device sign-ins, invite redemptions, lockouts,
 * governance requests, and a daily download digest.
 *
 * Transports:
 *   memory  - kept in an array (tests assert on it)
 *   console - one redacted log line per message (zero-cost development)
 *   smtp    - real email via nodemailer (production); the provider must be
 *             covered by a data processing agreement.
 *
 * Messages never contain photos, captions, or another member's email: they
 * say what happened and link back to the signed-in site for details.
 *
 * Delivery health: governance and security alerts depend on email, so a
 * broken SMTP setup must not be silent. `verify()` checks the connection
 * (at boot and every few hours), every send updates the state, and
 * `status()` feeds /readyz so an external uptime check sees it.
 */

function createNotifier({ transport = config.notifications.transport, createTransport } = {}) {
  const sent = [];
  let mailer = null;
  const state = { email: transport === 'smtp' ? 'unknown' : 'not_configured', lastFailureAt: null };

  function getMailer() {
    if (!mailer) {
      // Lazy so development never needs the dependency configured.
      const make = createTransport || require('nodemailer').createTransport;
      mailer = make(config.notifications.smtpUrl);
    }
    return mailer;
  }

  function markFailed(err) {
    state.email = 'failing';
    state.lastFailureAt = new Date().toISOString();
    // SMTP errors often quote the recipient ("550 <x@y>: rejected"): mask it.
    const message = String(err && err.message)
      .replace(/[^\s<>@"']+@[^\s<>@"']+/g, '[address]')
      .slice(0, 200);
    logger.error({ err: { message } }, 'email delivery failing');
  }

  async function deliver(to, subject, text, html) {
    if (transport === 'memory') {
      sent.push({ to, subject, text, ...(html ? { html } : {}), at: new Date().toISOString() });
      return;
    }
    if (transport === 'smtp') {
      try {
        await getMailer().sendMail({ from: config.notifications.from, to, subject, text, ...(html ? { html } : {}) });
        state.email = 'ok';
      } catch (err) {
        markFailed(err);
        throw err;
      }
      return;
    }
    logger.info({ notify: { subject, recipients: Array.isArray(to) ? to.length : 1 } }, 'notification');
  }

  /** Check the SMTP connection and credentials. Never throws. */
  async function verify() {
    if (transport !== 'smtp') {
      return state.email;
    }
    try {
      await getMailer().verify();
      state.email = 'ok';
      logger.info('email delivery check passed');
    } catch (err) {
      markFailed(err);
    }
    return state.email;
  }

  function status() {
    return { ...state };
  }

  /** Notify every active guardian (parent). Failures are logged, not thrown. */
  async function notifyGuardians(store, { subject, text, excludeUserId } = {}) {
    try {
      const users = await store.listUsers();
      const guardians = users.filter(
        (u) => u.role === 'parent' && !u.disabled && u.id !== excludeUserId
      );
      await Promise.all(
        guardians.map((g) =>
          deliver(g.email, `[${config.app.name}] ${subject}`, `${text}\n\n${config.publicOrigin}/admin`)
        )
      );
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'guardian notification failed');
    }
  }

  async function notifyUser(user, { subject, text }) {
    try {
      if (user && user.email && !user.disabled) {
        await deliver(user.email, `[${config.app.name}] ${subject}`, text);
      }
    } catch (err) {
      logger.warn({ err: { message: err.message } }, 'user notification failed');
    }
  }

  /**
   * Whether mail actually leaves the server. The console transport only logs
   * a line, so anything that must reach a person (an invite code) is not
   * sent through it.
   */
  function emailAvailable() {
    return transport === 'memory' || (transport === 'smtp' && Boolean(config.notifications.smtpUrl));
  }

  /**
   * Send one message to someone who is not (yet) a member, e.g. an invite.
   * No "[App]" subject prefix. Throws on failure so the caller can report it.
   */
  async function sendEmail({ to, subject, text, html }) {
    if (!emailAvailable()) {
      throw new Error('email is not configured');
    }
    await deliver(to, subject, text, html);
  }

  return { notifyGuardians, notifyUser, sendEmail, emailAvailable, verify, status, sent };
}

module.exports = { createNotifier };
