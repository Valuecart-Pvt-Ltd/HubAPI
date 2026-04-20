const passport = require('passport')
const MicrosoftStrategy = require('passport-microsoft').Strategy
const { query } = require('./db')
const { rowToUser } = require('./passport')

passport.use(
  'microsoft',
  new MicrosoftStrategy(
    {
      clientID:     process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      callbackURL:  process.env.MICROSOFT_CALLBACK_URL || '/api/auth/microsoft/callback',
      scope:        ['openid', 'profile', 'email', 'offline_access', 'Calendars.Read'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value
        if (!email) return done(new Error('Microsoft account has no email address'))

        const avatarUrl = profile.photos?.[0]?.value ?? null

        const { rows } = await query(
          `MERGE users AS tgt
             USING (VALUES ($1, $2, $3, $4, $5, $6))
                   AS src (email, name, microsoft_id, avatar_url, microsoft_access_token, microsoft_refresh_token)
             ON tgt.email = src.email
             WHEN MATCHED THEN UPDATE SET
               microsoft_id            = COALESCE(tgt.microsoft_id, src.microsoft_id),
               name                    = src.name,
               avatar_url              = COALESCE(src.avatar_url, tgt.avatar_url),
               microsoft_access_token  = src.microsoft_access_token,
               microsoft_refresh_token = COALESCE(src.microsoft_refresh_token, tgt.microsoft_refresh_token)
             WHEN NOT MATCHED THEN
               INSERT (email, name, microsoft_id, avatar_url, microsoft_access_token, microsoft_refresh_token)
               VALUES (src.email, src.name, src.microsoft_id, src.avatar_url,
                       src.microsoft_access_token, src.microsoft_refresh_token)
             OUTPUT INSERTED.*;`,
          [email, profile.displayName, profile.id, avatarUrl, accessToken, refreshToken ?? null],
        )

        done(null, rowToUser(rows[0]))
      } catch (err) {
        done(err)
      }
    },
  ),
)

module.exports = passport
