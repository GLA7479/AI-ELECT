const withPWA = /** @type {import("next-pwa").default} */ (
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("next-pwa")
)({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
});

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
};

module.exports = withPWA(nextConfig);

