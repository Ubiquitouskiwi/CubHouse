'use strict';

const express = require('express');

/**
 * Express 4 does not catch a rejected promise from an async handler: the
 * request hangs and Node may crash on the unhandled rejection. Every route in
 * this app is async, so wrap them all centrally instead of per handler.
 *
 * `createRouter()` returns a normal express.Router whose verb methods wrap
 * every function argument so a rejection is forwarded to `next(err)` and
 * reaches the error handler (500, process stays up).
 */

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function wrap(fn) {
  if (typeof fn !== 'function' || fn.length === 4) {
    // Error-handling middleware (err, req, res, next) is left untouched.
    return fn;
  }
  return function wrapped(req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(next);
      }
      return result;
    } catch (err) {
      return next(err);
    }
  };
}

function wrapArgs(args) {
  return args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a)));
}

function createRouter(options) {
  const router = express.Router(options);
  for (const verb of VERBS) {
    const original = router[verb].bind(router);
    router[verb] = (...args) => original(...wrapArgs(args));
  }
  return router;
}

module.exports = { createRouter, wrap };
