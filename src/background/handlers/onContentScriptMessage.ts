import browser, { Runtime } from "webextension-polyfill";
import { updateProxySettings } from "../../common/ts/proxySettings";
import { getStreamStatus, setStreamStatus } from "../../common/ts/streamStatus";
import store from "../../store";
import { MessageType, ProxyRequestType } from "../../types";

type Timeout = string | number | NodeJS.Timeout | undefined;

const timeoutMap: Map<ProxyRequestType, Timeout> = new Map();

export default function onContentScriptMessage(
  message: any,
  sender: Runtime.MessageSender,
  sendResponse?: (message: any) => void
): Promise<any> | true | undefined {
  if (message.type === MessageType.EnableFullMode) {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const requestType = message.requestType as ProxyRequestType;

    // Clear existing timeout for request type.
    if (timeoutMap.has(requestType)) {
      clearTimeout(timeoutMap.get(requestType));
    }

    // Set new timeout for request type.
    const timeoutMs = 10000;
    timeoutMap.set(
      requestType,
      setTimeout(() => {
        timeoutMap.delete(requestType);
        if (store.state.chromiumProxyActive) {
          updateProxySettings([...timeoutMap.keys()]);
        }
        console.log(
          `🔴 Disabled full mode (request type: ${requestType}, timeout: ${timeoutMs}ms)`
        );
        try {
          browser.tabs.sendMessage(tabId, {
            type: MessageType.DisableFullModeResponse,
            requestType,
            reason: "TIMEOUT",
          });
        } catch (error) {
          console.error(
            "❌ Failed to send DisableFullModeResponse message",
            error
          );
        }
      }, timeoutMs)
    );
    if (store.state.chromiumProxyActive) {
      updateProxySettings([...timeoutMap.keys()]);
    }

    console.log(
      `🟢 Enabled full mode for ${timeoutMs}ms (request type: ${requestType})`
    );
    try {
      browser.tabs.sendMessage(tabId, {
        type: MessageType.EnableFullModeResponse,
        requestType,
        reason: "ENABLED",
      });
    } catch (error) {
      console.error("❌ Failed to send EnableFullModeResponse message", error);
    }
  }

  if (message.type === MessageType.DisableFullMode) {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const requestType = message.requestType as ProxyRequestType;

    // Clear existing timeout for request type.
    if (timeoutMap.has(requestType)) {
      clearTimeout(timeoutMap.get(requestType));
      timeoutMap.delete(requestType);
    }
    if (store.state.chromiumProxyActive) {
      updateProxySettings([...timeoutMap.keys()]);
    }

    console.log(`🔴 Disabled full mode (request type: ${requestType})`);
    try {
      browser.tabs.sendMessage(tabId, {
        type: MessageType.DisableFullModeResponse,
        requestType,
        reason: "DISABLED",
      });
    } catch (error) {
      console.error("❌ Failed to send DisableFullModeResponse message", error);
    }
  }

  if (message.type === MessageType.UsherResponse) {
    const { channel, videoWeaverUrls, proxyCountry } = message;
    // Update Video Weaver URLs.
    store.state.videoWeaverUrlsByChannel[channel] = [
      ...(store.state.videoWeaverUrlsByChannel[channel] ?? []),
      ...videoWeaverUrls,
    ];
    // Update proxy country.
    const streamStatus = getStreamStatus(channel);
    setStreamStatus(channel, {
      ...(streamStatus ?? { proxied: false, reason: "" }),
      proxyCountry,
    });
  }
}
