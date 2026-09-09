import { PrismaClient } from '@prisma/client';

// Standard singleton pattern -- prevents exhausting the connection pool
// from hot-reloads in dev, and matches the pattern used on Vespermark's backend.
declare global {
  // eslint-disable-next-line no-var
  var prismaClient: PrismaClient | undefined;
}

export const prisma = global.prismaClient ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.prismaClient = prisma;
}
