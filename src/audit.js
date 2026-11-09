'use strict';

const crypto = require('crypto');
const { truncateIp, clientIp } = require('./security/clientInfo');

/**
 * Tamper-evident security audit trail.
 *
 * Every event is chained: hash = SHA-256(prevHash | seq | at | type | actor |
 * target | detailsHash). Changing, reordering, or removing any event breaks
 * verification of every event after it.
 *
 * Details are hashed separately (`detailsHash`) so the retention job can drop
 * old details (data minimization) without breaking the chain: the hash of
 * what was there survives, the content does not.
 *
 * The store exposes only append + list + a retention-only `redactAuditDetails`.
 * In Postgres the app role has no UPDATE/DELETE on this table (see
 * deploy/sql/001_security.sql); the redaction runs as a narrowly-scoped
 * function.
 */

const GENESIS = '0'.repeat(64);

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function eventHash(prevHash, e) {
  return sha256(
    [prevHash, e.seq, e.at, e.type, e.actorId || '', e.targetType || '', e.targetId || '', e.detailsHash].join('|')
  );
}

/** Build the next chained event from the previous one. Pure; for tests too. */
function buildEvent(prev, { type, actorId, targetType, targetId, details }, at = new Date()) {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : GENESIS;
  const safeDetails = details || {};
  const e = {
    id: crypto.randomUUID(),
    seq,
    at: at.toISOString(),
    type,
    actorId: actorId || null,
    targetType: targetType || null,
    targetId: targetId || null,
    details: safeDetails,
    detailsHash: sha256(canonical(safeDetails)),
    prevHash,
  };
  e.hash = eventHash(prevHash, e);
  return e;
}

/**
 * Verify the whole chain. Returns { ok, count, brokenAt } where brokenAt is the
 * seq of the first bad event. Redacted events are verified by detailsHash.
 */
function verifyChain(events) {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  for (const e of events) {
    if (e.seq !== expectedSeq || e.prevHash !== prevHash) {
      return { ok: false, count: events.length, brokenAt: e.seq };
    }
    if (!e.redacted && sha256(canonical(e.details || {})) !== e.detailsHash) {
      return { ok: false, count: events.length, brokenAt: e.seq };
    }
    if (eventHash(prevHash, e) !== e.hash) {
      return { ok: false, count: events.length, brokenAt: e.seq };
    }
    prevHash = e.hash;
    expectedSeq += 1;
  }
  return { ok: true, count: events.length, brokenAt: null };
}

/**
 * Record an audit event from a request context. Network details are minimized
 * (truncated IP). Never put passwords, codes, image bytes, or captions here.
 */
async function audit(store, req, type, { targetType, targetId, details } = {}) {
  const actorId = (req && req.session && req.session.userId) || null;
  const net = req ? truncateIp(clientIp(req)) : null;
  return store.appendSecurityAuditEvent({
    type,
    actorId,
    targetType,
    targetId,
    details: { ...(details || {}), ...(net ? { net } : {}) },
  });
}

module.exports = { audit, buildEvent, verifyChain, canonical, GENESIS };
