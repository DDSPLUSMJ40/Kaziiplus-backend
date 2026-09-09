import { z } from 'zod';

// Mirrors the client-side validation already in kazii-full-demo.html's
// submitSignup() -- server-side checks must never trust the client alone,
// but the RULES themselves (8-char password, required fields per type)
// should match what the UI already promises the user.

const baseFields = {
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters.'),
};

export const creatorSignupSchema = z.object({
  ...baseFields,
  accountType: z.literal('CREATOR'),
  firstName: z.string().min(1, 'First name is required.'),
  brandName: z.string().optional(),
});

export const supplierSignupSchema = z.object({
  ...baseFields,
  accountType: z.literal('SUPPLIER'),
  companyName: z.string().min(1, 'Company name is required.'),
  category: z.string().min(1),
  country: z.string().optional(),
});

export const manufacturerSignupSchema = z.object({
  ...baseFields,
  accountType: z.literal('MANUFACTURER'),
  companyName: z.string().min(1, 'Company name is required.'),
  specialty: z.string().min(1),
  country: z.string().optional(),
  moqUnits: z.coerce.number().int().positive().optional(),
  leadTimeDays: z.coerce.number().int().positive().optional(),
});

export const signupSchema = z.discriminatedUnion('accountType', [
  creatorSignupSchema,
  supplierSignupSchema,
  manufacturerSignupSchema,
]);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required.'),
});
