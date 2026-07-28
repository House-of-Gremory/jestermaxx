import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Origins allowed to hit the dev server. localhost/127.0.0.1 are always
  // allowed; these extras let a phone/second machine on the same wifi (LAN IP)
  // and the deployed domain reach the HTTPS dev server for two-person testing.
  allowedDevOrigins: [
    'nabin-paudel.com.np',
    '192.168.1.64',
    '192.168.1.*',
    '192.168.0.*',
    '10.0.0.*',
  ],
};

export default nextConfig;
