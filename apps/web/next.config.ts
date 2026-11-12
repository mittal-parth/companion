import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The account control sits at the bottom left of the sidebar.
  devIndicators: { position: "bottom-right" },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
