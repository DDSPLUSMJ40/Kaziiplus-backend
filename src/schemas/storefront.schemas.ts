import { z } from 'zod';

export const updateStorefrontSchema = z.object({
  storefrontSlug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and hyphens only.')
    .optional(),
  storefrontLive: z.boolean().optional(),
});
