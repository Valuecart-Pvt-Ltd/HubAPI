const { Router } = require('express')
const controller  = require('./orders.controller')
const { requireAuth } = require('../../middleware/authMiddleware')

const router = Router()

router.use(requireAuth)

router.get('/',          controller.list)
router.post('/checkout', controller.checkout)
router.get('/:id',       controller.getById)

module.exports = router
