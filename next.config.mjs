const nextConfig = {
  output: "standalone",
  /**
   * Front door hangs on origin-compressed .css and .js, so this server must not compress at all.
   *
   * The platform's front door attaches a caching rule matching url_file_extension in
   * ["jpg","png","css","ico","js"] whose override sets `compression_enabled = false` with
   * `cache_behavior = "HonorOrigin"`. Given a gzip body on one of those paths it never completes the
   * response: the request stays pending until the client gives up. Measured — identical request, only the
   * path differing: /repositories returns 200 gzip, and a .css returns nothing at all. Every browser sends
   * `Accept-Encoding: gzip`, so every page rendered unstyled while curl without that header looked fine.
   *
   * Leaving Next's default `compress: true` on would therefore break the dashboard for everyone. The cost is
   * that HTML is no longer compressed either; the front door can be told to compress these routes instead,
   * which is the better end state and needs a change to the frontends entry rather than to this file.
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
