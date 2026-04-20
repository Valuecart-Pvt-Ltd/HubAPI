const { Router } = require('express')
const controller  = require('./cart.controller')
const { requireAuth } = require('../../middleware/authMiddleware')

const router = Router()

router.use(requireAuth)

router.get('/',          controller.list)
router.post('/',         controller.addItem)
router.patch('/:itemId', controller.updateQuantity)
router.delete('/:itemId', controller.deleteItem)

module.exports = router
