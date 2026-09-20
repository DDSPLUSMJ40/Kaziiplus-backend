import { z } from 'zod';

export const printfulConnectSchema = z.object({
  apiToken: z.string().min(1, 'API token is required.'),
});
