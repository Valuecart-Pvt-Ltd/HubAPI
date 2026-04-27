import passport from 'passport'
import { Strategy as GoogleStrategy, Profile, VerifyCallback } from 'passport-google-oauth20'
import { execSP, sql } from '../db'
import { SERVER_URL } from './urls'
import type { User } from '../types/shared'

// ─── Row → domain type ────────────────────────────────────────────────────────

export function rowToUser(row: Record<string, unknown>): User {
  const created = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : String(row.created_at ?? new Date().toISOString())
  return {
    id:             row.id as string,
    email:          row.email as string,
    name:           row.name as string,
    department:     (row.department as string | null) ?? undefined,
    avatarUrl:      (row.avatar_url as string | null) ?? undefined,
    googleId:       (row.google_id as string | null) ?? undefined,
    microsoftId:    (row.microsoft_id as string | null) ?? undefined,
    trelloMemberId: (row.trello_member_id as string | null) ?? undefined,
    createdAt:      created,
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

    // Stored procedure handles the upsert (matches on google_id OR email).
    // refresh_token is preserved when the SP receives NULL (Google only sends it
    // on first authorisation).
    const rows = await execSP<Record<string, unknown>>('usp_UpsertGoogleUser', {
      GoogleId:     { type: sql.NVarChar(255),  value: profile.id },
      Email:        { type: sql.NVarChar(255),  value: email },
      Name:         { type: sql.NVarChar(255),  value: profile.displayName ?? email },
      AvatarUrl:    { type: sql.NVarChar(sql.MAX), value: avatarUrl },
      AccessToken:  { type: sql.NVarChar(sql.MAX), value: accessToken },
      RefreshToken: { type: sql.NVarChar(sql.MAX), value: refreshToken ?? null },
      TokenExpiry:  { type: sql.DateTime2,       value: null },
    })

    if (!rows[0]) return done(new Error('User upsert returned no row'))
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
