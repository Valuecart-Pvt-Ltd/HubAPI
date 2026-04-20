import passport from 'passport'
import { Strategy as GoogleStrategy, Profile, VerifyCallback } from 'passport-google-oauth20'
import { query } from '../db'
import { SERVER_URL } from './urls'
import type { User } from '../types/shared'

// ─── Row → domain type ────────────────────────────────────────────────────────

export function rowToUser(row: Record<string, unknown>): User {
  return {
    id:             row.id as string,
    email:          row.email as string,
    name:           row.name as string,
    department:     row.department as string | undefined,
    avatarUrl:      row.avatar_url as string | undefined,
    googleId:       row.google_id as string | undefined,
    microsoftId:    row.microsoft_id as string | undefined,
    trelloMemberId: row.trello_member_id as string | undefined,
    createdAt:      (row.created_at as Date).toISOString(),
  }
}

// ─── Google strategy ──────────────────────────────────────────────────────────

async function googleVerify(
  accessToken: string,
  refreshToken: string | undefined,
  profile: Profile,
  done: VerifyCallback,
) {
  try {
    const email = profile.emails?.[0]?.value
    if (!email) return done(new Error('Google account has no email address'))

    const avatarUrl = profile.photos?.[0]?.value ?? null

    // Upsert on email:
    //   - New users get inserted with all Google data.
    //   - Returning Google users get name, avatar, and access_token refreshed.
    //   - Email/password users who sign in via Google get google_id + tokens linked.
    //   - refresh_token is only sent on first authorisation, so we COALESCE to keep
    //     the existing one if Google didn't provide a new one this session.
    const { rows } = await query<Record<string, unknown>>(
      `INSERT INTO users
         (email, name, google_id, avatar_url, google_access_token, google_refresh_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         google_id            = COALESCE(users.google_id, EXCLUDED.google_id),
         name                 = EXCLUDED.name,
         avatar_url           = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         google_access_token  = EXCLUDED.google_access_token,
         google_refresh_token = COALESCE(EXCLUDED.google_refresh_token, users.google_refresh_token)
       RETURNING *`,
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
    done(err as Error)
  }
}

passport.use(
  new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL:  `${SERVER_URL}/api/auth/google/callback`,
    },
    googleVerify,
  ),
)

// No session serialization — stateless JWT auth.
export default passport
