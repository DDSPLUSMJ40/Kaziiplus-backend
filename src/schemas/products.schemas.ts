import { z } from 'zod';

export const createProductSchema = z.object({
  name: z.string().min(1, 'Product name is required.'),
  productType: z.string().min(1, 'Product type is required.'),
  color: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  designJson: z.any().optional(),
  // Base64-encoded PNG/JPEG, no data: prefix -- the Builder's uploaded
  // artwork layer, sent verbatim as the product's print file.
  printFileBase64: z.string().optional(),
  // Lets the Builder's Publish button go straight to LIVE on a
  // brand-new product (Publish clicked before any prior Save) --
  // without this, Zod silently strips an unrecognized status field
  // and the product ends up DRAFT despite reporting success.
  status: z.enum(['DRAFT', 'LIVE']).optional(),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  productType: z.string().min(1).optional(),
  color: z.string().optional(),
  price: z.coerce.number().positive().optional(),
  designJson: z.any().optional(),
  status: z.enum(['DRAFT', 'LIVE']).optional(),
  printFileBase64: z.string().optional(),
});
