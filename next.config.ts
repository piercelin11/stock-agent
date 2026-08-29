import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma 7 generated client + pg driver use import.meta.url to locate engine /
  // schema files; bundling breaks those paths. Keep them on Node's native
  // require so they resolve at runtime the same way `scripts/` do.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
