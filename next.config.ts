import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Required for MediaDevices.selectAudioOutput() (Android Bluetooth speakers).
          {
            key: "Permissions-Policy",
            value: "microphone=(self), speaker-selection=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
