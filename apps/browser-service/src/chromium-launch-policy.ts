export function chromiumNetworkLaunchPolicy(loopbackProxyUrl: string) {
  const parsed = new URL(loopbackProxyUrl);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port === "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("loopback HTTP proxy URL required");
  }
  return {
    proxy: { server: loopbackProxyUrl, bypass: "<-loopback>" },
    args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  } as const;
}
