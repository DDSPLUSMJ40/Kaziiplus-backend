import { z } from 'zod';

export const checkoutSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().positive().max(100).optional().default(1),
  customerEmail: z.string().email('Enter a valid email address.'),
});
