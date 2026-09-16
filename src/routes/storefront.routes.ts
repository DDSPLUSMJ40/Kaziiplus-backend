import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { getStorefront, updateMyStorefront, getMyOrders } from '../controllers/storefront.controller';
import { createCheckoutSession } from '../controllers/checkout.controller';

const router = Router();

router.get('/store/:slug', getStorefront);
// Public, unauthenticated, and calls Stripe -- wrapped so a Stripe/Prisma
// rejection (or the lazy FRONTEND_URL throw) reaches the global error
// handler instead of crashing the process. See asyncHandler.ts.
router.post('/store/:slug/checkout', asyncHandler(createCheckoutSession));

router.patch('/creators/me/storefront', requireAuth, requireAccountType('CREATOR'), updateMyStorefront);
router.get('/creators/me/orders', requireAuth, requireAccountType('CREATOR'), getMyOrders);

export default router;
