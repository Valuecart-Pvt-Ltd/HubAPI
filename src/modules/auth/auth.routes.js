const { Router } = require('express')
const passport    = require('../../config/passport')
const controller  = require('./auth.controller')
const { requireAuth } = require('../../middleware/authMiddleware')

const router = Router()

// ─── Google OAuth ────────────────────────────────────────────────────────────

router.get(
  '/google',
  controller.startGoogleOAuth,
)

router.get(
  '/google/callback',
  passport.authenticate('google', {
    session:         false,
    failureRedirect: `${process.env.CLIENT_URL}/login?error=oauth_failed`,
  }),
  controller.googleCallback,
)

router.get('/google/link', requireAuth, controller.startGoogleLink)

router.get(
  '/google/link/callback',
  passport.authenticate('google', {
    session:         false,
    failureRedirect: `${process.env.CLIENT_URL}/?error=link_failed`,
  }),
  controller.googleLinkCallback,
)

// ─── Microsoft OAuth ─────────────────────────────────────────────────────────

router.get('/microsoft', controller.startMicrosoftOAuth)

router.get(
  '/microsoft/callback',
  passport.authenticate('microsoft', {
    session:         false,
    failureRedirect: `${process.env.CLIENT_URL}/login?error=oauth_failed`,
  }),
  controller.microsoftCallback,
)

router.get('/microsoft/link', requireAuth, controller.startMicrosoftLink)

router.get(
  '/microsoft/link/callback',
  passport.authenticate('microsoft', {
    session:         false,
    failureRedirect: `${process.env.CLIENT_URL}/?error=link_failed`,
  }),
  controller.microsoftLinkCallback,
)

// ─── Local auth ──────────────────────────────────────────────────────────────

router.post('/register', controller.register)
router.post('/login',    controller.login)
router.post('/logout',   controller.logout)

// ─── Profile ─────────────────────────────────────────────────────────────────

router.patch('/profile', requireAuth, controller.updateProfile)
router.post('/avatar',   requireAuth, controller.uploadAvatar)
router.get('/me',        requireAuth, controller.getMe)

module.exports = router
