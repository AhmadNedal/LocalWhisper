import type { NextConfig } from "next";

/**
 * The UI is exported as static files (frontend/out) and loaded by Electron
 * through its private app:// protocol — there is no Node/Next server at runtime.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
