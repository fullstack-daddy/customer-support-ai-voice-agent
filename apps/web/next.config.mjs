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
  // Keeping your LAN origin for dev. Next wants the bare origin, not a
  // path — a missing comma after this line is a syntax error that takes
  // the whole config down, which is what was breaking the dev server.
  allowedDevOrigins: ['172.23.48.1'],
  // Never let a privileged value reach the client bundle.
  env: {},
  async headers() {
    return [
      {
        // The admin console must not be cached or indexed. (Was
        // /internal/* before the console moved to /admin.)
        source: '/admin/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' }
        ]
      }
    ];
  }
};

export default nextConfig;
