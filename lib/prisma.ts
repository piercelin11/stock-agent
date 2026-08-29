import "server-only";
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const makeClient = () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
};

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof makeClient>;
};

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
