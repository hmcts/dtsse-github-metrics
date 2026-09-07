const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["@hmcts-cft/cloud-native-platform", "applicationinsights", "@prisma/client", "pg", "config"],
  experimental: {
    staleTimes: {
      dynamic: 0
    }
  }
};

export default nextConfig;
