/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The @polkadot packages ship code that does not survive being re-bundled into a server
  // chunk (one of them contains an octal escape inside a template literal, which is a syntax
  // error in the emitted bundle). Loading them from node_modules at runtime avoids that and
  // keeps the server bundle small.
  serverExternalPackages: [
    "@polkadot/api",
    "@polkadot/api-augment",
    "@polkadot/api-base",
    "@polkadot/api-derive",
    "@polkadot/rpc-core",
    "@polkadot/rpc-provider",
    "@polkadot/types",
    "@polkadot/util",
    "@polkadot/util-crypto",
    "@polkadot/wasm-crypto",
  ],
  experimental: {
    // viem ships modern syntax; let Next transpile only what it must in the browser bundle.
    optimizePackageImports: ["viem"],
  },
};

export default nextConfig;
