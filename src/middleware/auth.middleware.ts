import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthedRequest extends Request {
  userId?: string;
  accountType?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { sub: string; accountType: string };
    req.userId = payload.sub;
    req.accountType = payload.accountType;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Restricts a route to specific account types -- e.g. only CREATOR can hit
// product-creation endpoints, only SUPPLIER/MANUFACTURER can update their own listing.
export function requireAccountType(...allowed: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.accountType || !allowed.includes(req.accountType)) {
      return res.status(403).json({ error: 'forbidden', message: `This action requires: ${allowed.join(', ')}` });
    }
    next();
  };
}
