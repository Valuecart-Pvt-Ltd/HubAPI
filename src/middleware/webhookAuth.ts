import { createHmac, timingSafeEqual } from 'crypto'
import { Request, Response, NextFunction } from 'express'

/**
 * Returns Express middleware that validates an HMAC-SHA256 signature on the
 * raw request body.
 *
 * The route MUST be mounted BEFORE express.json() so the body is still raw
 * bytes.  Use express.raw({ type: '*\/*' }) on the specific router instead.
 *
 * @param secretEnvVar  Name of the environment variable holding the shared secret
 * @param headerName    HTTP header that carries the signature (default: 'x-signature-sha256')
 * @param prefix        Optional prefix stripped before comparing (e.g. 'sha256=')
 */
export function webhookSignatureMiddleware(
  secretEnvVar: string,
  headerName = 'x-signature-sha256',
  prefix      = 'sha256=',
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = process.env[secretEnvVar]

    if (!secret) {
      // Secret not configured — skip verification (log a warning in dev)
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[webhookAuth] ${secretEnvVar} not set — skipping signature check`)
      }
      next()
      return
    }

    const rawSignature = req.headers[headerName] as string | undefined

    if (!rawSignature) {
      res.status(401).json({ error: 'Missing webhook signature header' })
      return
    }

    const signature = rawSignature.startsWith(prefix)
      ? rawSignature.slice(prefix.length)
      : rawSignature

    const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)

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
      // Buffer length mismatch → definitely not equal
    }

    if (!match) {
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    next()
  }
}

/**
 * express.raw() middleware that also saves the raw buffer to req.rawBody so
 * the HMAC middleware above can read it after body-parser has consumed the stream.
 */
export function captureRawBody(req: Request, _res: Response, next: NextFunction): void {
  // express.json() is applied globally and already consumed the stream — body is
  // already parsed.  Re-serialize to a Buffer so HMAC verification still works.
  if (req.body !== undefined && typeof req.body === 'object') {
    const raw = Buffer.from(JSON.stringify(req.body), 'utf8')
    ;(req as Request & { rawBody?: Buffer }).rawBody = raw
    next()
    return
  }

  // Fallback: body not yet parsed — read the raw stream ourselves.
  let data = Buffer.alloc(0)
  req.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]) })
  req.on('end',  () => {
    ;(req as Request & { rawBody?: Buffer }).rawBody = data
    try {
      req.body = JSON.parse(data.toString('utf8'))
    } catch {
      req.body = {}
    }
    next()
  })
}
