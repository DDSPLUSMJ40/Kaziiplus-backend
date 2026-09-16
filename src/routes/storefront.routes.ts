import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { getStorefront, updateMyStorefront, getMyOrders } from '../controllers/storefront.controller';

const router = Router();

router.get('/store/:slug', getStorefront);

router.patch('/creators/me/storefront', requireAuth, requireAccountType('CREATOR'), updateMyStorefront);
router.get('/creators/me/orders', requireAuth, requireAccountType('CREATOR'), getMyOrders);

export default router;
