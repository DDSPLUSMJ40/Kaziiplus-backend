import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/asyncHandler';
import { generateDesign } from '../controllers/ai.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/generate-design', asyncHandler(generateDesign));

export default router;
