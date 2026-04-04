/** @type {import('next').NextConfig} */
const distDir = process.env.NEXT_DIST_DIR || ".next";

const nextConfig = {
  typedRoutes: false,
  distDir,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

module.exports = nextConfig;
