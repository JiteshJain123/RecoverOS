/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile TypeScript source from internal workspace packages directly.
  transpilePackages: ["@recoveros/shared"],
};

export default nextConfig;
