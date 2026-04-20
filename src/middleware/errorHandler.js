function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500
  const code       = err.code       || 'internal_error'
  console.error(`[${statusCode}] ${code}: ${err.message}`)
  if (err.stack) console.error(err.stack)
  res.status(statusCode).json({
    success: false,
    error:   err.message || 'Internal Server Error',
    code,
    statusCode,
  })
}

module.exports = errorHandler
