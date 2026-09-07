import type { NextConfig } from 'next';

const nextConfig: NextConfig = { output: 'export', trailingSlash: true, basePath: process.env.BASE_PATH || '' };

export default nextConfig;
