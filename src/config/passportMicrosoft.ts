import passport from 'passport'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MicrosoftStrategy = require('passport-microsoft').Strategy
import { query, sql } from '../db'
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

        // No dedicated SP for Microsoft upsert — inline MERGE.
        const rows = await query<Record<string, unknown>>(
          `MERGE users AS target
           USING (VALUES (@Email, @Name, @MicrosoftId, @AvatarUrl, @AccessToken, @RefreshToken))
                 AS src (email, name, microsoft_id, avatar_url, microsoft_access_token, microsoft_refresh_token)
             ON target.email = src.email
           WHEN MATCHED THEN UPDATE SET
             microsoft_id            = ISNULL(target.microsoft_id, src.microsoft_id),
             name                    = src.name,
             avatar_url              = ISNULL(src.avatar_url, target.avatar_url),
             microsoft_access_token  = src.microsoft_access_token,
             microsoft_refresh_token = ISNULL(src.microsoft_refresh_token, target.microsoft_refresh_token)
           WHEN NOT MATCHED THEN INSERT
             (id, email, name, microsoft_id, avatar_url, microsoft_access_token, microsoft_refresh_token)
             VALUES (NEWID(), src.email, src.name, src.microsoft_id, src.avatar_url,
                     src.microsoft_access_token, src.microsoft_refresh_token)
           OUTPUT inserted.*;`,
          {
            Email:        { type: sql.NVarChar(255),     value: email },
            Name:         { type: sql.NVarChar(255),     value: profile.displayName ?? email },
            MicrosoftId:  { type: sql.NVarChar(255),     value: profile.id },
            AvatarUrl:    { type: sql.NVarChar(sql.MAX), value: avatarUrl },
            AccessToken:  { type: sql.NVarChar(sql.MAX), value: accessToken },
            RefreshToken: { type: sql.NVarChar(sql.MAX), value: refreshToken ?? null },
          },
        )

        if (!rows[0]) return done(new Error('Microsoft user upsert returned no row'))
        done(null, rowToUser(rows[0]))
      } catch (err) {
        done(err as Error)
      }
    },
  ),
)

export default passport
