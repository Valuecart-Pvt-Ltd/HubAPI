const { Router } = require('express')
const controller  = require('./webhooks.controller')
const { requireAuth } = require('../../middleware/authMiddleware')
const { captureRawBody, webhookSignatureMiddleware } = require('../../middleware/webhookAuth')

const router = Router()

// ─── Inbound webhooks (HMAC-verified) ────────────────────────────────────────

router.post(
  '/readai/:webhookKey',
  captureRawBody,
  webhookSignatureMiddleware('READAI_WEBHOOK_SECRET', 'x-readai-signature'),
  controller.readaiInbound,
)

router.post(
  '/fireflies/:webhookKey',
  captureRawBody,
  webhookSignatureMiddleware('FIREFLIES_WEBHOOK_SECRET', 'x-hub-signature-256'),
  controller.firefliesInbound,
)

// ─── User-managed settings (JWT-authenticated) ───────────────────────────────

router.get('/settings',                          requireAuth, controller.getSettings)
router.patch('/settings/:provider',              requireAuth, controller.updateSetting)
router.post('/settings/:provider/regenerate',    requireAuth, controller.regenerateKey)

module.exports = router
