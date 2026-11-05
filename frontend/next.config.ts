import type { NextConfig } from "next";
import path from "path";

const FLYER_RENDER_FILES = [
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
];

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
  // Flyer PDFs are rendered to JPEG for embedding in emails. pdf.js loads its
  // worker by path and the canvas binary is native, so neither can be traced.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/chat": [
      "../data/knowledge/**/*",
      "../data/programs/**/*.json",
      ...FLYER_RENDER_FILES,
    ],
    "/api/generate-flier": FLYER_RENDER_FILES,
  },
};

export default nextConfig;
