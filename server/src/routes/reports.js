
'use strict';
/* HTTP layer for /api/reports. The handlers are plain functions, so they can be tested without a running server.
   The real work happens in src/services/*.

     GET  /api/reports            all reports, newest first          (add ?mine=1 to get only this device's reports)
     GET  /api/reports/:id        one report, or 404
     POST /api/reports            create a report                    (JSON body, header X-Client-Id required)
     PATCH /api/reports/:id       admin review: change status / level, add a remark   (JSON body; ADMIN LOGIN REQUIRED)

   About X-Client-Id: an anonymous id the browser makes once and keeps. It only LABELS reports as "mine".
   It is not a password and does not protect anything. Phase 1 has nothing that needs protecting by it:
   there is no edit or delete, and the id is never returned by the API. Admin features come with real login in Phase 3. */

const { AppError } = require('../middleware/errors');
const { requireAdmin } = require('../middleware/adminAuth');
const { assertSameOrigin } = require('../middleware/origin');
const { validateNewReport, validateUpdate, parseClientId } = require('../services/reportValidation');
const { createReport, listReports, getReport, updateReport } = require('../services/reportService');

function createReportHandlers({ db, geo, config, now, aiService }) {
  const deps = { geo, uploadsDir: config.uploadsDir, now };
  const client = (req) => parseClientId(req.headers['x-client-id']);

  return {
    list(req, res, next) {
      try {
        const cid = client(req);
        const mineOnly = Boolean(req.query) && (req.query.mine === '1' || req.query.mine === 'true');
        if (mineOnly && cid.state !== 'ok') {
          throw new AppError(400, 'CLIENT_ID_REQUIRED', 'Send a valid X-Client-Id header to list your own reports.');
        }
        const reports = listReports(db, deps, { clientId: cid.state === 'ok' ? cid.id : null, mineOnly });
        res.json({ reports });
      } catch (err) {
        next(err);
      }
    },

    getOne(req, res, next) {
      try {
        const cid = client(req);
        const report = getReport(db, deps, req.params.id, cid.state === 'ok' ? cid.id : null);
        if (!report) throw new AppError(404, 'NOT_FOUND', 'No such report.');
        res.json({ report });
      } catch (err) {
        next(err);
      }
    },

    /* PATCH /api/reports/:id   body: { status?, level?, remark? }
       Needs a signed-in admin. The router puts requireAdmin() in front, and this handler checks req.admin AGAIN, so the
       handler is never open by accident. After the login, these safety rails still apply:
         - config.adminWrites must be on (by default only on a local-only, non-production server)
         - a request that comes from another website (Origin header) is refused
         - the body must be application/json, which browsers will not send cross-site without a CORS permission */
    update(req, res, next) {
      try {
        if (!req.admin) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in as an admin to do this.');
        if (!config.adminWrites) {
          throw new AppError(403, 'ADMIN_WRITES_DISABLED', 'Admin changes are turned off on this server. They have no login yet, so they only work on a local development server.');
        }
        assertSameOrigin(req);
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the change as JSON (Content-Type: application/json).');
        }
        const { value, errors } = validateUpdate(req.body);
        if (!value) throw new AppError(400, 'VALIDATION', 'Please check the change and try again.', errors);

        const cid = client(req);
        const outcome = updateReport(db, deps, req.params.id, value, cid.state === 'ok' ? cid.id : null);
        if (!outcome) throw new AppError(404, 'NOT_FOUND', 'No such report.');
        res.json({ report: outcome.report, changed: outcome.changed });
      } catch (err) {
        next(err);
      }
    },

    async create(req, res, next) {
      try {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the report as JSON (Content-Type: application/json).');
        }

        const cid = client(req);
        if (cid.state === 'missing') throw new AppError(400, 'CLIENT_ID_REQUIRED', 'Send your anonymous device id in the X-Client-Id header.');
        if (cid.state === 'invalid') throw new AppError(400, 'INVALID_CLIENT_ID', 'X-Client-Id must be 16 to 64 letters, numbers, "-" or "_".');

        const { value, errors } = validateNewReport(req.body, { geo, maxPhotoBytes: config.maxPhotoBytes });
        if (!value) throw new AppError(400, 'VALIDATION', 'Please check the report and try again.', errors);

        if (!aiService || typeof aiService.analyzeReport !== 'function') {
          throw new AppError(503, 'AI_UNAVAILABLE', 'The report assessment service is unavailable. Please try again later.');
        }

        const assessment = await aiService.analyzeReport({
          desc: value.desc,
          selectedType: value.type,
          photo: value.photo,
        });

        const allowedOutcomes = [
          'hazard_detected',
          'no_hazard_detected',
          'uncertain',
          'unsupported',
        ];

        const allowedTypes = [
          'tree', 'drain', 'road', 'pole',
          'flood', 'slope', 'river', 'wall', 'other',
        ];

        const allowedLevels = ['hi', 'mod', 'lo'];
        const allowedSources = ['gemini', 'fallback'];

        if (
          !assessment ||
          !allowedOutcomes.includes(assessment.outcome)
        ) {
          throw new AppError(
            422,
            'AI_INVALID_ASSESSMENT',
            'The report assessment was invalid. Please try again.'
          );
        }

        if (assessment.outcome !== 'hazard_detected') {
          const outcomeErrors = {
            no_hazard_detected: [
              'AI_NO_HAZARD',
              'No relevant community hazard was identified. Please review your submission.',
            ],
            uncertain: [
              'AI_UNCERTAIN',
              'We could not determine whether this is a relevant hazard. Please add a clearer description or photo and try again.',
            ],
            unsupported: [
              'AI_UNSUPPORTED',
              'This submission appears outside READYLINK’s community disaster-risk reporting scope.',
            ],
          };

          const [code, message] = outcomeErrors[assessment.outcome];

          throw new AppError(422, code, message);
        }

        if (
          !allowedTypes.includes(assessment.type) ||
          !allowedLevels.includes(assessment.level) ||
          (
            assessment.type === 'other' &&
            (
              typeof assessment.hazardName !== 'string' ||
              assessment.hazardName.trim().length < 3 ||
              assessment.hazardName.trim().length > 60
            )
          ) ||
          (
            assessment.type !== 'other' &&
            assessment.hazardName !== null
          )
        ) {
          throw new AppError(
            422,
            'AI_UNCLASSIFIED',
            'The report could not be classified. Please add a clearer description and try again.'
          );
        }

        if (
          !allowedSources.includes(assessment.source) ||
          typeof assessment.reason !== 'string' ||
          assessment.reason.trim().length < 10 ||
          assessment.reason.trim().length > 200
        ) {
          throw new AppError(
            422,
            'AI_INVALID_ASSESSMENT',
            'The report assessment was invalid. Please try again.'
          );
        }

        const trustedValue = {
          ...value,
          type: assessment.type,
          level: assessment.level,
          assessment: {
            outcome: assessment.outcome,
            level: assessment.level,
            source: assessment.source,
            hazardName: assessment.hazardName,
            reason: assessment.reason.trim(),
            demo: Boolean(assessment.demo),
          },
        };

        const report = createReport(db, deps, trustedValue, cid.id);
        res.status(201).set('Location', `/api/reports/${report.id}`).json({ report });
      } catch (err) {
        next(err);
      }
    },
  };
}

/* Needs Express. Kept separate so the handlers above can be tested without it. */
function createReportsRouter(handlers, config, { auth }) {
  const express = require('express');
  const router = express.Router();
  router.get('/', handlers.list);
  router.get('/:id', handlers.getOne);
  // The photo travels inside the JSON as base64, so this route allows a bigger body than a normal API call.
  router.post('/', express.json({ limit: config.jsonLimitBytes, strict: true }), handlers.create);
  // A status change is a tiny body: keep the limit small.
  router.patch('/:id', requireAdmin(auth), express.json({ limit: '32kb', strict: true }), handlers.update);
  return router;
}

module.exports = { createReportHandlers, createReportsRouter };
