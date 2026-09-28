import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { getFormationQuote, createFormationCheckout, listFormationOrders } from '../controllers/formation.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.get('/quote', asyncHandler(getFormationQuote));
router.post('/checkout', asyncHandler(createFormationCheckout));
router.get('/orders', asyncHandler(listFormationOrders));

export default router;
