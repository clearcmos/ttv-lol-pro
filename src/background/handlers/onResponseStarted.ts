import browser, { WebRequest } from "webextension-polyfill";
import findChannelFromTwitchTvUrl from "../../common/ts/findChannelFromTwitchTvUrl";
import findChannelFromUsherUrl from "../../common/ts/findChannelFromUsherUrl";
import findChannelFromVideoWeaverUrl from "../../common/ts/findChannelFromVideoWeaverUrl";
import getHostFromUrl from "../../common/ts/getHostFromUrl";
import { normalizeIpAddress } from "../../common/ts/ipAddress";
import isChromium from "../../common/ts/isChromium";
import isRequestTypeProxied from "../../common/ts/isRequestTypeProxied";
import {
  getProxyInfoFromUrl,
  getUrlFromProxyInfo,
} from "../../common/ts/proxyInfo";
import {
  passportHostRegex,
  twitchGqlHostRegex,
  twitchTvHostRegex,
  usherHostRegex,
  videoWeaverHostRegex,
} from "../../common/ts/regexes";
import { getStreamStatus, setStreamStatus } from "../../common/ts/streamStatus";
import store from "../../store";
import { ProxyInfo, ProxyRequestType } from "../../types";

export default async function onResponseStarted(
  details: WebRequest.OnResponseStartedDetailsType & {
    proxyInfo?: ProxyInfo;
  }
): Promise<void> {
  const host = getHostFromUrl(details.url);
  if (!host) return;

  let proxy: string | null = null;
  let errorMessage: string | null = null;
  try {
    proxy = getProxyFromDetails(details);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : `${error}`;
  }

  const requestParams = {
    isChromium: isChromium,
    optimizedProxiesEnabled: store.state.optimizedProxiesEnabled,
    passportLevel: store.state.passportLevel,
    customPassport: store.state.customPassportEnabled
      ? store.state.customPassport
      : null,
  };
  const proxiedPassportRequest = isRequestTypeProxied(
    ProxyRequestType.Passport,
    requestParams
  );
  const proxiedUsherRequest = isRequestTypeProxied(
    ProxyRequestType.Usher,
    requestParams
  );
  const proxiedVideoWeaverRequest = isRequestTypeProxied(
    ProxyRequestType.VideoWeaver,
    requestParams
  );
  const proxiedGraphQLRequest = isRequestTypeProxied(
    ProxyRequestType.GraphQL,
    requestParams
  );
  const proxiedTwitchWebpageRequest = isRequestTypeProxied(
    ProxyRequestType.TwitchWebpage,
    requestParams
  );

  // Passport requests.
  if (proxiedPassportRequest && passportHostRegex.test(host)) {
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }

  // Usher requests.
  if (proxiedUsherRequest && usherHostRegex.test(host)) {
    let channelName = findChannelFromUsherUrl(details.url);
    if (!channelName) {
      try {
        const tab = await browser.tabs.get(details.tabId);
        channelName = findChannelFromTwitchTvUrl(tab.url);
      } catch {}
    }
    await updateStreamStatus(channelName, proxy, errorMessage);

    if (!proxy) {
      return console.log(
        `❌ Did not proxy ${details.url} (${channelName ?? "unknown"})`
      );
    }
    console.log(
      `✅ Proxied ${details.url} (${channelName ?? "unknown"}) through ${proxy}`
    );
  }

  // Video-weaver requests.
  if (proxiedVideoWeaverRequest && videoWeaverHostRegex.test(host)) {
    let channelName = findChannelFromVideoWeaverUrl(details.url);
    if (!channelName) {
      try {
        const tab = await browser.tabs.get(details.tabId);
        channelName = findChannelFromTwitchTvUrl(tab.url);
      } catch {}
    }
    await updateStreamStatus(channelName, proxy, errorMessage);

    if (!proxy) {
      return console.log(
        `❌ Did not proxy ${details.url} (${channelName ?? "unknown"})`
      );
    }
    console.log(
      `✅ Proxied ${details.url} (${channelName ?? "unknown"}) through ${proxy}`
    );
  }

  // Twitch GraphQL requests.
  if (proxiedGraphQLRequest && twitchGqlHostRegex.test(host)) {
    if (!proxy && store.state.optimizedProxiesEnabled) return; // Expected for most requests.
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }

  // Twitch webpage requests.
  if (proxiedTwitchWebpageRequest && twitchTvHostRegex.test(host)) {
    if (!proxy) return console.log(`❌ Did not proxy ${details.url}`);
    console.log(`✅ Proxied ${details.url} through ${proxy}`);
  }
}

function getProxyFromDetails(
  details: WebRequest.OnResponseStartedDetailsType & {
    proxyInfo?: ProxyInfo;
  }
): string | null {
  if (isChromium) {
    const proxies = Array.from(
      new Set([...store.state.optimizedProxies, ...store.state.normalProxies])
    );
    const isDnsError =
      proxies.length !== 0 && store.state.dnsResponses.length === 0;
    if (isDnsError) {
      throw new Error(
        "Cannot detect if requests are being proxied due to a DNS error"
      );
    }
    const ip = details.ip;
    if (!ip) return null;
    const normalizedIp = normalizeIpAddress(ip) ?? ip;
    const dnsResponse = store.state.dnsResponses.find(dnsResponse =>
      dnsResponse.ips.some(responseIp => {
        const normalizedResponseIp = normalizeIpAddress(responseIp);
        return (normalizedResponseIp ?? responseIp) === normalizedIp;
      })
    );
    if (!dnsResponse) return null;
    const proxyInfoArray = proxies.map(getProxyInfoFromUrl);
    const possibleProxies = proxyInfoArray.filter(
      proxy => proxy.host === dnsResponse.host
    );
    if (possibleProxies.length === 0) return dnsResponse.host;
    return getUrlFromProxyInfo(possibleProxies[0]);
  } else {
    const proxyInfo = details.proxyInfo; // Firefox only.
    if (!proxyInfo || proxyInfo.type === "direct") return null;
    return getUrlFromProxyInfo(proxyInfo);
  }
}

async function updateStreamStatus(
  channelName: string | null,
  proxy: string | null,
  errorMessage: string | null
) {
  const streamStatus = getStreamStatus(channelName);
  const stats = streamStatus?.stats ?? { proxied: 0, notProxied: 0 };

  if (!proxy) {
    stats.notProxied++;
    let reason = errorMessage ?? streamStatus?.reason ?? "";
    try {
      const proxySettings = await browser.proxy.settings.get({});
      switch (proxySettings.levelOfControl) {
        case "controlled_by_other_extensions":
          reason = "Proxy settings controlled by other extension";
          break;
        case "not_controllable":
          reason = "Proxy settings not controllable";
          break;
      }
    } catch {}
    setStreamStatus(channelName, {
      proxied: false,
      proxyHost: streamStatus?.proxyHost ? streamStatus.proxyHost : undefined,
      proxyCountry: streamStatus?.proxyCountry,
      reason,
      stats,
    });
    return;
  }

  stats.proxied++;
  setStreamStatus(channelName, {
    proxied: true,
    proxyHost: proxy,
    proxyCountry: streamStatus?.proxyCountry,
    reason: streamStatus?.reason ?? "",
    stats,
  });
}
