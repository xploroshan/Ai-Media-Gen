import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@reelforge/shared"],
  eslint: {
    // linted via `pnpm lint` (next lint); avoid double-run during build
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
