import { Request, Response, NextFunction } from 'express';

// Express 4 does not forward a rejected promise from an async route
// handler to next() automatically -- only a *synchronous* throw is caught
// for you. Without this wrapper, a Stripe or Prisma rejection (or the
// lazy STRIPE_SECRET_KEY/FRONTEND_URL throw) inside an async handler
// becomes an unhandled promise rejection instead of a clean error
// response, and under Node's default behavior that can crash the whole
// process -- taking every route, including /health and /auth, down with
// it. Wrap any route handler that awaits a third-party or DB call with
// this so its rejections reach errorHandler.ts instead.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
