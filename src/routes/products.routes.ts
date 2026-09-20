import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { createProduct, listProducts, getProduct, updateProduct, deleteProduct, getPrintFile } from '../controllers/products.controller';

const router = Router();

// Public -- must be registered before the auth gate below. Fulfillment
// providers fetch this directly; they have no creator JWT.
router.get('/:id/print-file.png', getPrintFile);

router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/', createProduct);
router.get('/', listProducts);
router.get('/:id', getProduct);
router.patch('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
