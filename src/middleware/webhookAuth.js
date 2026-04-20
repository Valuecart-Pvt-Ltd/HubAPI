const { createHmac, timingSafeEqual } = require('crypto')

/**
 * Returns Express middleware that validates an HMAC-SHA256 signature on the
 * raw request body. Secret comes from an env var name passed in by the caller.
 */
function webhookSignatureMiddleware(
  secretEnvVar,
  headerName = 'x-signature-sha256',
  prefix      = 'sha256=',
) {
  return (req, res, next) => {
    const secret = process.env[secretEnvVar]

    if (!secret) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[webhookAuth] ${secretEnvVar} not set — skipping signature check`)
      }
      next()
      return
    }

    const rawSignature = req.headers[headerName]

    if (!rawSignature) {
      res.status(401).json({ error: 'Missing webhook signature header' })
      return
    }

    const signature = rawSignature.startsWith(prefix)
      ? rawSignature.slice(prefix.length)
      : rawSignature

    const rawBody = req.rawBody || Buffer.alloc(0)

    const expected = createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')

    let match = false
    try {
      match = timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature,  'hex'),
      )
    } catch {
      /* buffer length mismatch → definitely not equal */
    }

    if (!match) {
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    next()
  }
}

/**
 * Saves a raw Buffer of the already-parsed JSON body to req.rawBody so the
 * HMAC middleware can verify it even after express.json() has run.
 */
function captureRawBody(req, _res, next) {
  if (req.body !== undefined && typeof req.body === 'object') {
    req.rawBody = Buffer.from(JSON.stringify(req.body), 'utf8')
    next()
    return
  }

  let data = Buffer.alloc(0)
  req.on('data', (chunk) => { data = Buffer.concat([data, chunk]) })
  req.on('end',  () => {
    req.rawBody = data
    try {
      req.body = JSON.parse(data.toString('utf8'))
    } catch {
      req.body = {}
    }
    next()
  })
}

module.exports = { webhookSignatureMiddleware, captureRawBody }
