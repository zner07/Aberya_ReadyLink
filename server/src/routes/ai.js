'use strict';
/* HTTP layer for /api/ai.
     POST /api/ai/analyze -> { analysis: { outcome, type, level, hazardName, reason, source, demo } }
   Outcomes:
     - hazard_detected
     - no_hazard_detected
     - uncertain
     - unsupported
   Non-hazard outcomes return null for type, level, and hazardName.
   Enforces JSON content type, same-origin protection, valid X-Client-Id, input validation,
   and independent client-based and IP-based rate limiting. */
const { AppError } = require('../middleware/errors');
const { assertSameOrigin, assertJson } = require('../middleware/origin');
const { parseClientId, HAZARD_TYPES, MAX_DESC_LENGTH } = require('../services/reportValidation');
const { createCounter } = require('../services/rateLimiter');

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateAnalyzeBody(body, { maxPhotoBytes = 5 * 1024 * 1024 } = {}) {
  if (!isPlainObject(body)) {
    return { value: null, errors: { _body: 'Send the analysis request as a JSON object.' } };
  }

  const errors = {};
  let desc = '';
  let selectedType = null;
  let photo = null;

  if (body.desc !== undefined && body.desc !== null) {
    if (typeof body.desc !== 'string') {
      errors.desc = 'The description must be text.';
    } else {
      const cleaned = body.desc.replace(CONTROL_CHARS, '').trim();
      if (cleaned.length > MAX_DESC_LENGTH) errors.desc = `Use ${MAX_DESC_LENGTH} characters or fewer.`;
      else desc = cleaned;
    }
  }

  if (body.selectedType !== undefined && body.selectedType !== null && body.selectedType !== '') {
    if (typeof body.selectedType !== 'string' || !HAZARD_TYPES.includes(body.selectedType)) {
      errors.selectedType = `Choose one of: ${HAZARD_TYPES.join(', ')}.`;
    } else {
      selectedType = body.selectedType;
    }
  }

  if (body.photo !== undefined && body.photo !== null) {
    try {
      const { decodePhoto } = require('../services/photoService');
      photo = decodePhoto(body.photo, { maxBytes: maxPhotoBytes });
    } catch (err) {
      errors.photo = err.message || 'The photo could not be validated.';
    }
  }

  if (!desc && !selectedType && !photo) {
    errors.desc = 'Provide a hazard description, a selected sample category, or a photo.';
  }

  if (Object.keys(errors).length) return { value: null, errors };
  return { value: { desc, selectedType, photo }, errors: {} };
}

function createAiHandlers({
  aiService,
  now = Date.now,
  maxPerClient = 15,
  maxPerIp = 30,
  windowMs = 10 * 60 * 1000,
  maxPhotoBytes = 5 * 1024 * 1024,
}) {
  const clientLimiter = createCounter({ max: maxPerClient, windowMs, now });
  const ipLimiter = createCounter({ max: maxPerIp, windowMs, now });

  return {
    async analyze(req, res, next) {
      try {
        assertSameOrigin(req);
        assertJson(req);

        const cid = parseClientId(req.headers['x-client-id']);
        if (cid.state === 'missing') {
          throw new AppError(400, 'CLIENT_ID_REQUIRED', 'Send your anonymous device id in the X-Client-Id header.');
        }
        if (cid.state === 'invalid') {
          throw new AppError(400, 'INVALID_CLIENT_ID', 'X-Client-Id must be 16 to 64 letters, numbers, "-" or "_".');
        }

        // Check per-client limit before incrementing the network-wide IP limiter so
        // client-throttled retries do not prematurely exhaust the shared IP quota.
        const clientHit = clientLimiter.hit(cid.id);
        if (!clientHit.allowed) {
          res.set('Retry-After', String(clientHit.retryAfterSec));
          throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many AI analysis requests. Please wait a moment and try again.');
        }

        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        const ipHit = ipLimiter.hit(ip);
        if (!ipHit.allowed) {
          res.set('Retry-After', String(ipHit.retryAfterSec));
          throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many AI analysis requests from this network. Please wait a moment and try again.');
        }

        const { value, errors } = validateAnalyzeBody(req.body, { maxPhotoBytes });
        if (!value) {
          throw new AppError(400, 'VALIDATION', 'Please check the report details and try again.', errors);
        }

        const analysis = await aiService.analyzeReport(value);
        res.json({ analysis });
      } catch (err) {
        next(err);
      }
    },
  };
}

function createAiRouter(handlers, { jsonLimitBytes = '8mb' } = {}) {
  const express = require('express');
  const router = express.Router();
  router.post('/analyze', express.json({ limit: jsonLimitBytes, strict: true }), handlers.analyze);
  return router;
}

module.exports = { createAiHandlers, createAiRouter, validateAnalyzeBody };