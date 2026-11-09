'use strict';

const { createRouter } = require('../security/asyncRouter');
const { requireParentPage } = require('../auth');
const { buildUsageReport, parseRange } = require('../usage');

/**
 * Guardian-only Usage page: aggregate counts and trends so the guardians can
 * decide whether the site is worth keeping. No names, ids or per-person rows
 * reach the template (see buildUsageReport).
 */
module.exports = function usageRoutes(ctx) {
  const { store, config } = ctx;
  const router = createRouter();

  router.get('/admin/usage', requireParentPage, async (req, res) => {
    const report = await buildUsageReport({ store, range: parseRange(req.query.range) });
    // Already no-store app-wide; repeated here so the page never depends on
    // middleware order.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.render('usage', { title: 'Usage', report, retentionDays: config.privacy.usageRetentionDays });
  });

  return router;
};
