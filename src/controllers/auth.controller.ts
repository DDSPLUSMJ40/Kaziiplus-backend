import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { signupSchema, loginSchema } from '../schemas/auth.schemas';
import { slugify } from '../lib/slugify';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';

function signToken(userId: string, accountType: string) {
  if (!JWT_SECRET) {
    // Fail loudly rather than silently signing with an empty/undefined secret --
    // an unset JWT_SECRET in production is a real security hole, not an edge case to shrug off.
    throw new Error('JWT_SECRET is not set. Refusing to issue a token.');
  }
  return jwt.sign({ sub: userId, accountType }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export async function generateUniqueStorefrontSlug(base: string): Promise<string> {
  const baseSlug = slugify(base) || 'creator';
  let candidate = baseSlug;
  let attempt = 0;
  while (await prisma.creatorProfile.findUnique({ where: { storefrontSlug: candidate } })) {
    attempt += 1;
    candidate = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    if (attempt > 5) break; // astronomically unlikely to loop this long; don't hang the request
  }
  return candidate;
}

export async function signup(req: Request, res: Response) {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    return res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const storefrontSlug =
    data.accountType === 'CREATOR' ? await generateUniqueStorefrontSlug(data.brandName || data.firstName) : undefined;

  const user = await prisma.user.create({
    data: {
      email: data.email,
      passwordHash,
      accountType: data.accountType,
      ...(data.accountType === 'CREATOR' && {
        creatorProfile: {
          create: { firstName: data.firstName, brandName: data.brandName ?? null, storefrontSlug },
        },
      }),
      ...(data.accountType === 'SUPPLIER' && {
        supplierProfile: {
          create: { companyName: data.companyName, category: data.category, country: data.country ?? '' },
        },
      }),
      ...(data.accountType === 'MANUFACTURER' && {
        manufacturerProfile: {
          create: {
            companyName: data.companyName,
            specialty: data.specialty,
            country: data.country ?? '',
            moqUnits: data.moqUnits ?? 0,
            leadTimeDays: data.leadTimeDays ?? 0,
          },
        },
      }),
    },
    select: { id: true, email: true, accountType: true },
  });

  const token = signToken(user.id, user.accountType);
  return res.status(201).json({ user, token });
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // Deliberately identical error for "no such user" and "wrong password" --
  // distinguishing them lets an attacker enumerate registered emails.
  const invalidMsg = { error: 'invalid_credentials', message: 'Incorrect email or password.' };
  if (!user) return res.status(401).json(invalidMsg);

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json(invalidMsg);

  const token = signToken(user.id, user.accountType);
  return res.json({ user: { id: user.id, email: user.email, accountType: user.accountType }, token });
}
