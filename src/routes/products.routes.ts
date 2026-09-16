import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { createProduct, listProducts, getProduct, updateProduct, deleteProduct } from '../controllers/products.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/', createProduct);
router.get('/', listProducts);
router.get('/:id', getProduct);
router.patch('/:id', updateProduct);
router.delete('/:id', deleteProduct);

export default router;
