import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * These packages resolve a path to a native binary relative to their own
   * `__dirname`. Bundling them rewrites that path and the lookup silently
   * fails, so they must stay as real `node_modules` requires on the server.
   */
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],

  // Reference images are served through an API route that reads from the
  // storage directory, so the image optimiser has nothing to add.
  images: { unoptimized: true },
};

export default nextConfig;
