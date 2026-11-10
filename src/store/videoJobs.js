'use strict';

const crypto = require('crypto');

/**
 * Video processing jobs: shared shape and claim rules for both stores.
 *
 * A job is created when an upload finishes (the original sits in the video
 * work directory) and is processed by src/jobs/videoQueue.js:
 *   queued -> running -> done (photoId set) | failed (reason code set)
 *
 * Only ONE job runs at a time across every instance: a claim is refused while
 * another job holds an unexpired lease. A running job whose lease ran out
 * (crash, restart, a release swap) is claimed again, up to maxAttempts runs
 * in total; after that it is marked failed with reason "processing_failed".
 */

const JOB_STATUS = Object.freeze(['queued', 'running', 'done', 'failed']);
const JOB_MUTABLE = Object.freeze([
  'status',
  'attempts',
  'runAfter',
  'leaseUntil',
  'mediaId',
  'plannedSegments',
  'photoId',
  'reason',
  'finishedAt',
]);

function newVideoJob(fields, now = Date.now()) {
  const at = new Date(now).toISOString();
  return {
    id: fields.id || crypto.randomUUID(),
    ownerId: fields.ownerId,
    ownerName: fields.ownerName || null,
    status: 'queued',
    attempts: 0,
    runAfter: at,
    leaseUntil: null,
    bytes: Number(fields.bytes) || 0,
    durationMs: Number(fields.durationMs) || 0,
    caption: fields.caption || '',
    pendingApproval: fields.pendingApproval === true,
    mediaId: null,
    plannedSegments: 0,
    photoId: null,
    reason: null,
    finishedAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function applyJobChanges(job, changes, now = Date.now()) {
  for (const key of JOB_MUTABLE) {
    if (changes[key] !== undefined) {
      job[key] = changes[key];
    }
  }
  if (!JOB_STATUS.includes(job.status)) {
    throw new Error(`invalid video job status "${job.status}"`);
  }
  job.updatedAt = new Date(now).toISOString();
  return job;
}

/**
 * Decide a claim over the open jobs (queued or running). Pure: returns the
 * job to run (already updated) and the jobs that ran out of attempts (already
 * marked failed). The caller persists both.
 */
function planClaim(openJobs, { now, leaseMs, maxAttempts }) {
  const nowIso = new Date(now).toISOString();
  const leaseLive = (j) => j.status === 'running' && j.leaseUntil && j.leaseUntil > nowIso;
  const stuck = (j) => j.status === 'running' && !leaseLive(j);
  const exhausted = [];
  for (const j of openJobs) {
    if (stuck(j) && j.attempts >= maxAttempts) {
      applyJobChanges(j, { status: 'failed', reason: 'processing_failed', leaseUntil: null, finishedAt: nowIso }, now);
      exhausted.push(j);
    }
  }
  if (openJobs.some(leaseLive)) {
    return { claim: null, exhausted };
  }
  const candidates = openJobs
    .filter((j) => (j.status === 'queued' && j.runAfter <= nowIso) || (stuck(j) && j.attempts < maxAttempts))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const claim = candidates[0] || null;
  if (claim) {
    applyJobChanges(
      claim,
      { status: 'running', attempts: claim.attempts + 1, leaseUntil: new Date(now + leaseMs).toISOString() },
      now
    );
  }
  return { claim, exhausted };
}

module.exports = { newVideoJob, applyJobChanges, planClaim, JOB_STATUS };
