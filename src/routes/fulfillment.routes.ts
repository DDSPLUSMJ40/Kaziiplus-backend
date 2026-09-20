import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import {
  connectPrintful,
  disconnectPrintful,
  getPrintfulStatus,
  getPrintfulCatalog,
  getPrintfulCatalogProduct,
} from '../controllers/fulfillment.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/printful/connect', connectPrintful);
router.delete('/printful/connect', disconnectPrintful);
router.get('/printful/status', getPrintfulStatus);
router.get('/printful/catalog', getPrintfulCatalog);
router.get('/printful/catalog/:id', getPrintfulCatalogProduct);

export default router;
