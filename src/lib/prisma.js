// src/lib/prisma.js
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__PRISMA__ || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__PRISMA__ = prisma;
}

export default prisma;
