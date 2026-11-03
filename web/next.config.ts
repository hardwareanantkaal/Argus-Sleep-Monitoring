import type { NextConfig } from 'next';

// The backend (Express + Socket.IO) runs separately. In dev we proxy it through
// Next so the browser sees one origin and the httpOnly cookies just work.
// In production Nginx does the same job and these rewrites are not used.
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:3100';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Production runs Next.js in a Docker container: build a self-contained server (.next/standalone).
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${BACKEND}/api/v1/:path*` },
      { source: '/socket.io/:path*', destination: `${BACKEND}/socket.io/:path*` },
    ];
  },
};

export default nextConfig;
