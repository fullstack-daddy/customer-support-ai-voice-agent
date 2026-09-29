/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Agent SDK spawns the MCP server as a child process. Bundling it
  // would break that, so it stays external and is required at runtime.
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@relaypay/agent',
    '@relaypay/mcp-server'
  ],
  // Never let a privileged value reach the client bundle.
  env: {},
  async headers() {
    return [
      {
        // The review dashboard and API must not be cached or indexed.
        source: '/internal/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' }
        ]
      }
    ];
  }
};

export default nextConfig;
