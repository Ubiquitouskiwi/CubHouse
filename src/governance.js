'use strict';

const { audit } = require('./audit');
const { logger, errorFields } = require('./logger');

/**
 * Two-guardian governance.
 *
 * Rule (docs/SECURITY_PRIVACY_PLAN.md, section 3.3):
 *   - Any one guardian can always RESTRICT alone, immediately: hide, narrow
 *     an audience, lock downloads, revoke codes, remove a member.
 *   - Actions that WIDEN exposure or DESTROY the archive need the other
 *     guardian's approval when there are two or more guardians:
 *       photos becoming visible to the whole family, enabling download,
 *       adding someone to a group, creating an invite code, changing a role,
 *       bulk delete, erasing the archive.
 *   - With a single guardian, the same actions wait `soloDelayMs` (24 hours
 *     in production) and notify, so a hijacked lone parent account cannot
 *     silently publish or wipe everything at once.
 *
 * This protects the child in a custody dispute without ever blocking an
 * emergency lockdown.
 */

function createGovernance({ store, config, notifier, executors }) {
  async function activeGuardians() {
    const users = await store.listUsers();
    return users.filter((u) => u.role === 'parent' && !u.disabled);
  }

  async function execute(request, req) {
    const executor = executors[request.type];
    if (!executor) {
      throw new Error(`no executor for governance type ${request.type}`);
    }
    const result = await executor(request.payload, { requestedBy: request.requestedBy, req });
    await audit(store, req, 'governance.executed', {
      targetType: 'governance',
      targetId: request.id,
      details: { type: request.type, summary: request.summary },
    });
    return result;
  }

  /**
   * Ask to perform a governed action. Returns:
   *   { status: 'executed', result }  ran now (solo guardian, no delay)
   *   { status: 'pending', request }  waiting for approval or the delay
   */
  async function requestAction(req, { type, payload, summary }) {
    const guardians = await activeGuardians();
    const requestedBy = req.session.userId;
    const now = Date.now();
    const solo = guardians.length <= 1;

    if (solo && config.governance.soloDelayMs <= 0) {
      const tmp = { id: null, type, payload, summary, requestedBy };
      const result = await execute(tmp, req);
      return { status: 'executed', result };
    }

    const request = await store.createGovernanceRequest({
      type,
      payload,
      summary,
      requestedBy,
      executeAfter: solo ? new Date(now + config.governance.soloDelayMs).toISOString() : null,
      expiresAt: new Date(now + config.governance.requestTtlMs).toISOString(),
    });
    await audit(store, req, 'governance.requested', {
      targetType: 'governance',
      targetId: request.id,
      details: { type, summary, solo },
    });
    await notifier.notifyGuardians(store, {
      subject: solo ? 'A protected change is scheduled' : 'A change needs your approval',
      text: solo
        ? `A protected change was requested: "${summary}". It will take effect after the safety delay unless cancelled.`
        : `Another guardian asked to: "${summary}". Sign in to approve or decline it.`,
      excludeUserId: solo ? undefined : requestedBy,
    });
    return { status: 'pending', request };
  }

  /** A second guardian approves; the requester cannot approve their own. */
  async function approve(req, id) {
    const request = await store.findGovernanceRequest(id);
    if (!request || request.status !== 'pending') {
      return { ok: false, error: 'That request is no longer pending.' };
    }
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) {
      await store.decideGovernanceRequest(id, { status: 'expired' });
      return { ok: false, error: 'That request expired.' };
    }
    // Nobody ever approves their own request, whatever the guardian count.
    // (Before, a guardian who removed the other could then self-approve.)
    // A solo guardian's delayed requests run on their own via runDue().
    if (request.requestedBy === req.session.userId) {
      return { ok: false, error: 'Another guardian must approve this change.' };
    }
    const decided = await store.decideGovernanceRequest(id, {
      status: 'approved',
      decidedBy: req.session.userId,
    });
    if (!decided) {
      return { ok: false, error: 'That request is no longer pending.' };
    }
    const result = await execute(decided, req);
    return { ok: true, result };
  }

  /** Decline (another guardian) or cancel (the requester). */
  async function decline(req, id) {
    const decided = await store.decideGovernanceRequest(id, {
      status: 'declined',
      decidedBy: req.session.userId,
    });
    if (decided) {
      await audit(store, req, 'governance.declined', {
        targetType: 'governance',
        targetId: id,
        details: { type: decided.type, summary: decided.summary },
      });
    }
    return Boolean(decided);
  }

  /**
   * Background tick: run solo-delayed requests whose delay has passed (only
   * while there is still a single guardian; once a second guardian exists
   * they must approve), and expire stale requests.
   */
  async function runDue(now = Date.now()) {
    const pending = await store.listGovernanceRequests({ status: 'pending' });
    const guardians = await activeGuardians();
    let executed = 0;
    for (const request of pending) {
      try {
        if (request.expiresAt && Date.parse(request.expiresAt) <= now) {
          await store.decideGovernanceRequest(request.id, { status: 'expired' });
          continue;
        }
        if (guardians.length <= 1 && request.executeAfter && Date.parse(request.executeAfter) <= now) {
          const decided = await store.decideGovernanceRequest(request.id, { status: 'approved' });
          if (decided) {
            await execute(decided, null);
            executed += 1;
          }
        }
      } catch (err) {
        logger.error({ ...errorFields(err), governanceId: request.id }, 'governance execution failed');
      }
    }
    return executed;
  }

  return { requestAction, approve, decline, runDue, activeGuardians };
}

module.exports = { createGovernance };
