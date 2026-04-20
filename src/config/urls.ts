// CLIENT_URL may be a comma-separated list (e.g. "http://localhost:5173,https://hub.example.com")
// to allow multiple origins through CORS. Redirects always go to the first entry.

const raw = process.env.CLIENT_URL ?? 'http://localhost:5173'

export const CLIENT_ORIGINS = raw.split(',').map(s => s.trim()).filter(Boolean)
export const CLIENT_URL     = CLIENT_ORIGINS[0] ?? 'http://localhost:5173'

export const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:4000'
