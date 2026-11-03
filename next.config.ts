import type { NextConfig } from "next";

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

// Other machines on the LAN testing `next dev` (e.g. NEXT_DEV_ORIGINS=192.168.1.196): Next blocks their dev requests otherwise
const devOrigins = (process.env.NEXT_DEV_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
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

