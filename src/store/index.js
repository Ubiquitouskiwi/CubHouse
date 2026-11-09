'use strict';

/**
 * Data store factory.
 *
 * `createStore()` picks the backing store from the environment: PostgreSQL
 * when DATABASE_URL is set, otherwise the in-memory store. Both expose the
 * same async interface, so application code is identical in both modes.
 *
 * Creation is lazy (nothing is constructed at require time), so requiring
 * this module never throws even when DATABASE_URL points at a store that is
 * not available yet. Safe boot refuses to run production on the memory store.
 */

const { MemoryStore } = require('./memoryStore');

function createStore(env = process.env) {
  if (env.DATABASE_URL) {
    let PgStore;
    try {
      ({ PgStore } = require('./pgStore'));
    } catch (err) {
      throw new Error(
        'DATABASE_URL is set but the PostgreSQL data store is not available: ' + err.message,
        { cause: err }
      );
    }
    return new PgStore(env.DATABASE_URL);
  }
  return new MemoryStore();
}

module.exports = { createStore };
