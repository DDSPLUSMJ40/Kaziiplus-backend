import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(1, 'Product name is required.'),
  productType: z.string().min(1, 'Product type is required.'),
  color: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  designJson: z.any().optional(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  productType: z.string().min(1).optional(),
  color: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  designJson: z.any().optional(),
  status: z.enum(['DRAFT', 'LIVE']).optional(),
});
