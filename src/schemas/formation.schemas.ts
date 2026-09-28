import { z } from 'zod';

export const USPS_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export const stateSchema = z.enum(USPS_STATES);

export const formationQuoteQuerySchema = z.object({ state: stateSchema });

export const formationCheckoutSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(1, 'Company name is required.')
    .max(120, 'Company name must be 120 characters or fewer.')
    .refine((v) => /(^|[\s,])llc$/i.test(v), 'Company name must end in "LLC".'),
  state: stateSchema,
  founderName: z.string().trim().min(1).max(120),
  founderEmail: z.string().trim().email().max(200),
  mailingAddress: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: stateSchema,
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Enter a 5-digit ZIP code.'),
  }),
  acknowledged: z.literal(true, {
    errorMap: () => ({ message: 'You must acknowledge that Kazii+ is not a law firm.' }),
  }),
});

export type FormationCheckoutInput = z.infer<typeof formationCheckoutSchema>;
