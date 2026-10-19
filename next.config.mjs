/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.RECRUNO_BUILD_DIR || ".next",
  reactStrictMode: true
};

export default nextConfig;
