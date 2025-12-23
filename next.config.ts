import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    mcpServer: true,
    browserDebugInfoInTerminal: true,
  },
  /* config options here */
};

export default nextConfig;
