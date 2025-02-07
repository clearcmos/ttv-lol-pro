import isChromium from "../common/ts/isChromium";
import type { State } from "./types";

export default function getDefaultState() {
  const state: State = {
    activeChannelSubscriptions: [],
    adLog: [],
    adLogEnabled: true,
    adLogLastSent: 0,
    allowOtherProxyProtocols: false,
    anonymousMode: true,
    chromiumProxyActive: false,
    dnsResponses: [],
    normalProxies: [],
    openedTwitchTabs: [],
    optimizedProxies: isChromium
      ? ["chromium.api.cdn-perfprod.com:2023"]
      : ["firefox.api.cdn-perfprod.com:2023"],
    optimizedProxiesEnabled: true,
    passportLevel: 0,
    streamStatuses: {},
    videoWeaverUrlsByChannel: {},
    whitelistChannelSubscriptions: true,
    whitelistedChannels: [],
  };
  return state;
}
