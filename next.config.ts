import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    mcpServer: true,
  },
  logging: {
    browserToTerminal: true,
  },
};

export default nextConfig;
