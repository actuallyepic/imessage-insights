import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    mcpServer: true,
    browserDebugInfoInTerminal: true,
  },
  /* config options here */
};

export default nextConfig;
