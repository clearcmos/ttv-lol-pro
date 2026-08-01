import onStartupStoreCleanup from "../../background/handlers/onStartupStoreCleanup";
import store from "../../store";
import { ProxyRequestType, ProxyType } from "../../types";
import isRequestTypeProxied from "./isRequestTypeProxied";
import { getProxyInfoFromUrl, getUrlFromProxyInfo } from "./proxyInfo";
import {
  passportHostRegex,
  twitchGqlHostRegex,
  twitchTvHostRegex,
  usherHostRegex,
  videoWeaverHostRegex,
} from "./regexes";
import updateDnsResponses from "./updateDnsResponses";

const PROXY_TYPE_MAP: Readonly<Record<ProxyType, string>> = Object.freeze({
  direct: "DIRECT",
  http: "PROXY",
  https: "HTTPS",
  socks: "SOCKS5",
  socks4: "SOCKS4",
});

export async function updateProxySettings(
  requestFilter?: ProxyRequestType[]
): Promise<boolean> {
  const { optimizedProxiesEnabled, passportLevel } = store.state;

  const proxies = optimizedProxiesEnabled
    ? store.state.optimizedProxies
    : store.state.normalProxies;
  const proxyInfoString = getProxyInfoStringFromUrls(proxies);

  const getRequestParams = (requestType: ProxyRequestType) => ({
    isChromium: true,
    optimizedProxiesEnabled: optimizedProxiesEnabled,
    passportLevel: passportLevel,
    customPassport: store.state.customPassportEnabled
      ? store.state.customPassport
      : null,
    fullModeEnabled:
      !optimizedProxiesEnabled ||
      (requestFilter != null && requestFilter.includes(requestType)),
  });
  const proxyPassportRequests = isRequestTypeProxied(
    ProxyRequestType.Passport,
    getRequestParams(ProxyRequestType.Passport)
  );
  const proxyUsherRequests = isRequestTypeProxied(
    ProxyRequestType.Usher,
    getRequestParams(ProxyRequestType.Usher)
  );
  const proxyVideoWeaverRequests = isRequestTypeProxied(
    ProxyRequestType.VideoWeaver,
    getRequestParams(ProxyRequestType.VideoWeaver)
  );
  const proxyGraphQLRequests = isRequestTypeProxied(
    ProxyRequestType.GraphQL,
    getRequestParams(ProxyRequestType.GraphQL)
  );
  const proxyTwitchWebpageRequests = isRequestTypeProxied(
    ProxyRequestType.TwitchWebpage,
    getRequestParams(ProxyRequestType.TwitchWebpage)
  );

  const config: chrome.proxy.ProxyConfig = {
    mode: "pac_script",
    pacScript: {
      data: `
        function FindProxyForURL(url, host) {
          // Passport requests.
          if (${proxyPassportRequests} && ${passportHostRegex}.test(host)) {
            return "${proxyInfoString}";
          }
          // Usher requests.
          if (${proxyUsherRequests} && ${usherHostRegex}.test(host)) {
            return "${proxyInfoString}";
          }
          // Video Weaver requests.
          if (${proxyVideoWeaverRequests} && ${videoWeaverHostRegex}.test(host)) {
            return "${proxyInfoString}";
          }
          // GraphQL requests.
          if (${proxyGraphQLRequests} && ${twitchGqlHostRegex}.test(host)) {
            return "${proxyInfoString}";
          }
          // Twitch webpage requests.
          if (${proxyTwitchWebpageRequests} && ${twitchTvHostRegex}.test(host)) {
            return "${proxyInfoString}";
          }
          return "DIRECT";
        }
      `,
    },
  };

  const applied = await new Promise<boolean>(resolve => {
    chrome.proxy.settings.set({ value: config, scope: "regular" }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error(`Failed to update proxy settings: ${error.message}`);
        resolve(false);
        return;
      }
      console.log(
        `Proxying requests through one of: ${proxies.toString() || "<empty>"}`
      );
      resolve(true);
    });
  });
  if (!applied) return false;
  store.state.chromiumProxyActive = true;
  void updateDnsResponses();
  return true;
}

function getProxyInfoStringFromUrls(urls: string[]): string {
  return [
    ...urls.map(url => {
      const proxyInfo = getProxyInfoFromUrl(url);
      return `${PROXY_TYPE_MAP[proxyInfo.type]} ${getUrlFromProxyInfo({
        ...proxyInfo,
        // Don't include username/password in PAC script.
        username: undefined,
        password: undefined,
      })}`;
    }),
    "DIRECT",
  ].join("; ");
}

export async function clearProxySettings(): Promise<boolean> {
  const cleared = await new Promise<boolean>(resolve => {
    chrome.proxy.settings.clear({ scope: "regular" }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error(`Failed to clear proxy settings: ${error.message}`);
        resolve(false);
        return;
      }
      console.log("Proxy settings cleared");
      resolve(true);
    });
  });
  if (!cleared) return false;
  store.state.chromiumProxyActive = false;

  if (
    Date.now() - store.state.lastStoreCleanupTimestamp >
    1000 * 60 * 60 * 24 * 7 // 7 days
  ) {
    onStartupStoreCleanup();
  }
  return true;
}
