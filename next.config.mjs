const nextConfig = {
  output: "standalone",
  /**
   * The front door never completes a response for an origin-compressed .css or .js, so do not compress here.
   *
   * It attaches a caching rule matching `url_file_extension` in ["jpg","png","css","ico","js"] whose override
   * sets `compression_enabled = false` with `cache_behavior = "HonorOrigin"`. Handed a gzip body on one of those
   * paths the request simply stays pending, which renders every page unstyled. Turning Next's default back on
   * breaks the dashboard in AAT while looking fine locally.
   *
   * The cost is uncompressed HTML too. Telling the front door to compress these routes is the better end state
   * and is a change to the frontends entry, not to this file.
   */
  compress: false,
  serverExternalPackages: ["@hmcts-cft/cloud-native-platform", "applicationinsights", "@prisma/client", "pg", "config"],
  experimental: {
    staleTimes: {
      dynamic: 0
    }
  }
};

export default nextConfig;
