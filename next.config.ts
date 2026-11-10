import type { NextConfig } from "next";

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

// Other machines on the LAN testing `next dev` (e.g. NEXT_DEV_ORIGINS=192.168.1.196): Next blocks their dev requests otherwise
const devOrigins = (process.env.NEXT_DEV_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

// Keys the service worker's asset cache (public/sw.js): each deploy starts a fresh cache
const assetVersion = (process.env.GITHUB_SHA || "").slice(0, 12) || String(Date.now());

// A git worktree's node_modules live in the main checkout, outside the folder Turbopack takes as its root: name the
// main checkout here (NEXT_TURBOPACK_ROOT=/path/to/librecorsa) to build or run a worktree with Turbopack
const turbopackRoot = process.env.NEXT_TURBOPACK_ROOT;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(turbopackRoot ? { turbopack: { root: turbopackRoot } } : {}),
  env: { NEXT_PUBLIC_ASSET_VERSION: assetVersion },
  ...(devOrigins.length ? { allowedDevOrigins: devOrigins } : {}),
  output: "export",
  images: {
    unoptimized: true,
  },
  ...(basePath
    ? {
        basePath,
        assetPrefix: `${basePath}/`,
      }
    : {}),
};

export default nextConfig;

