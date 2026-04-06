import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // All /api/* routes are handled by Next.js App Router route handlers
  // (frontend/src/app/api/**). No proxy rewrites needed.

  // The agent's searchKnowledge tool reads files from ../data/knowledge and
  // ../data/programs at runtime via process.cwd(). Those paths sit OUTSIDE the
  // Next.js project root (frontend/), so by default Vercel's file tracing does
  // not bundle them and the tool silently returns no results in production.
  //
  // Hoist the trace root one level up so relative ../data/** paths resolve,
  // and explicitly include the data directories in the bundle for any function
  // that may read them.
  outputFileTracingRoot: path.join(__dirname, ".."),
  outputFileTracingIncludes: {
    "/api/chat": [
      "../data/knowledge/**/*",
      "../data/programs/**/*.json",
    ],
  },
};

export default nextConfig;
