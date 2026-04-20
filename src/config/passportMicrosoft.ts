import passport from 'passport'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MicrosoftStrategy = require('passport-microsoft').Strategy
import { query } from '../db'
import type { User } from '../types/shared'
import { rowToUser } from './passport'

passport.use(
  'microsoft',
  new MicrosoftStrategy(
    {
      clientID:     process.env.MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
      callbackURL:  '/api/auth/microsoft/callback',
      scope:        ['openid', 'profile', 'email', 'offline_access', 'Calendars.Read'],
    },
    async (
      accessToken: string,
      refreshToken: string,
      profile: {
        id: string
        displayName: string
        emails?: { value: string }[]
        photos?: { value: string }[]
      },
      done: (err: Error | null, user?: User) => void,
    ) => {
      try {
        const email = profile.emails?.[0]?.value
        if (!email) return done(new Error('Microsoft account has no email address'))

        const avatarUrl = profile.photos?.[0]?.value ?? null

        const { rows } = await query<Record<string, unknown>>(
          `INSERT INTO users
             (email, name, microsoft_id, avatar_url, microsoft_access_token, microsoft_refresh_token)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (email) DO UPDATE SET
             microsoft_id            = COALESCE(users.microsoft_id, EXCLUDED.microsoft_id),
             name                    = EXCLUDED.name,
             avatar_url              = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
             microsoft_access_token  = EXCLUDED.microsoft_access_token,
             microsoft_refresh_token = COALESCE(EXCLUDED.microsoft_refresh_token, users.microsoft_refresh_token)
           RETURNING *`,
          [email, profile.displayName, profile.id, avatarUrl, accessToken, refreshToken ?? null],
        )

        done(null, rowToUser(rows[0]))
      } catch (err) {
        done(err as Error)
      }
    },
  ),
)

export default passport
