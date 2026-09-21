import { z } from 'zod';

export const generateDesignSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required.').max(500, 'Keep prompts under 500 characters.'),
});
