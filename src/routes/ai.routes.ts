import { Router } from 'express';
import { requireAuth, requireAccountType } from '../middleware/auth.middleware';
import { generateDesign } from '../controllers/ai.controller';

const router = Router();
router.use(requireAuth, requireAccountType('CREATOR'));

router.post('/generate-design', generateDesign);

export default router;
