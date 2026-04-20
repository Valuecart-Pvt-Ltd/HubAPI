const passport = require('passport')
const { Strategy: GoogleStrategy } = require('passport-google-oauth20')
const { query } = require('./db')

// ─── Row → domain object ─────────────────────────────────────────────────────

function rowToUser(row) {
  if (!row) return null
  return {
    id:             row.id,
    email:          row.email,
    name:           row.name,
    department:     row.department       ?? undefined,
    avatarUrl:      row.avatar_url       ?? undefined,
    googleId:       row.google_id        ?? undefined,
    microsoftId:    row.microsoft_id     ?? undefined,
    trelloMemberId: row.trello_member_id ?? undefined,
    createdAt:      row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
  }
}

// ─── Google strategy ──────────────────────────────────────────────────────────
//
// Upsert on email using MERGE (MSSQL equivalent of PG `ON CONFLICT ... DO UPDATE`).
// `OUTPUT INSERTED.*` returns the final row after insert OR update.

async function googleVerify(accessToken, refreshToken, profile, done) {
  try {
    const email = profile.emails?.[0]?.value
    if (!email) return done(new Error('Google account has no email address'))

    const avatarUrl = profile.photos?.[0]?.value ?? null

    const { rows } = await query(
      `MERGE users AS tgt
         USING (VALUES ($1, $2, $3, $4, $5, $6))
               AS src (email, name, google_id, avatar_url, google_access_token, google_refresh_token)
         ON tgt.email = src.email
         WHEN MATCHED THEN UPDATE SET
           google_id            = COALESCE(tgt.google_id, src.google_id),
           name                 = src.name,
           avatar_url           = COALESCE(src.avatar_url, tgt.avatar_url),
           google_access_token  = src.google_access_token,
           google_refresh_token = COALESCE(src.google_refresh_token, tgt.google_refresh_token)
         WHEN NOT MATCHED THEN
           INSERT (email, name, google_id, avatar_url, google_access_token, google_refresh_token)
           VALUES (src.email, src.name, src.google_id, src.avatar_url,
                   src.google_access_token, src.google_refresh_token)
         OUTPUT INSERTED.*;`,
      [
        email,
        profile.displayName,
        profile.id,
        avatarUrl,
        accessToken,
        refreshToken ?? null,
      ],
    )

    done(null, rowToUser(rows[0]))
  } catch (err) {
    done(err)
  }
}

passport.use(
  new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback',
    },
    googleVerify,
  ),
)

// No session serialization — stateless JWT auth.
module.exports = passport
module.exports.rowToUser = rowToUser
