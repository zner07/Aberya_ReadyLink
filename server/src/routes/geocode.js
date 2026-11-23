'use strict';
/* Place search through this server.
     GET /api/geocode/search?q=alangilan            -> { results: [{ label, lat, lng, inArea }] }
     GET /api/geocode/reverse?lat=13.78&lng=121.06  -> { label, lat, lng, inArea }
   Public (residents need it), so it has its own limit per address. The typed text is sent to the chosen provider (see README). */
const { AppError } = require('../middleware/errors');
const { createCounter } = require('../services/rateLimiter');

const asNumber = (v) => (typeof v === 'string' && /^-?\d{1,3}(\.\d{1,12})?$/.test(v.trim()) ? Number(v) : NaN);

function createGeocodeHandlers({ geocoder, now = Date.now }) {
  const limiter = createCounter({ max: 30, windowMs: 60 * 1000, now }); // 30 searches per minute per address
  function limit(req, res) {
    const hit = limiter.hit(`ip:${(req.socket && req.socket.remoteAddress) || 'unknown'}`);
    if (!hit.allowed) {
      res.set('Retry-After', String(hit.retryAfterSec));
      throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many searches. Wait a moment and try again.');
    }
  }
  return {
    async search(req, res, next) {
      try {
        limit(req, res);
        const q = req.query && typeof req.query.q === 'string' ? req.query.q : '';
        res.json(await geocoder.search(q));
      } catch (err) {
        next(err);
      }
    },
    async reverse(req, res, next) {
      try {
        limit(req, res);
        res.json(await geocoder.reverse(asNumber(req.query && req.query.lat), asNumber(req.query && req.query.lng)));
      } catch (err) {
        next(err);
      }
    },
  };
}

function createGeocodeRouter(handlers) {
  const express = require('express'); // loaded here, so the handlers above can be unit-tested without Express
  const router = express.Router();
  router.get('/search', handlers.search);
  router.get('/reverse', handlers.reverse);
  return router;
}

module.exports = { createGeocodeHandlers, createGeocodeRouter };
