import { Request, Response, NextFunction } from 'express';

// Catch-all error handler -- must be the LAST app.use() call in index.ts,
// after every route, so Express recognizes it as error-handling middleware
// (by its 4-argument signature) and routes here any error forwarded via
// next(err). Pair route handlers that can reject (Stripe/Prisma calls, the
// lazy STRIPE_SECRET_KEY/FRONTEND_URL throws) with asyncHandler() -- see
// asyncHandler.ts -- so their rejections actually reach next() and land
// here as a clean 500 instead of becoming an unhandled promise rejection
// that can crash the whole process.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
}
