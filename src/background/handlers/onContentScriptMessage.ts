import browser, { Runtime } from "webextension-polyfill";
import isChromium from "../../common/ts/isChromium";
import { updateProxySettings } from "../../common/ts/proxySettings";
import { getStreamStatus, setStreamStatus } from "../../common/ts/streamStatus";
import store from "../../store";
import { MessageType, ProxyRequestType } from "../../types";

type Timeout = ReturnType<typeof setTimeout>;

interface ActiveFullModeRequest {
  requestType: ProxyRequestType;
  timeout: Timeout;
}

const activeFullModeRequests = new Map<string, ActiveFullModeRequest>();
let proxySettingsUpdateQueue: Promise<boolean> = Promise.resolve(true);

function getActiveRequestTypes(): ProxyRequestType[] {
  return Array.from(
    new Set(
      [...activeFullModeRequests.values()].map(request => request.requestType)
    )
  );
}

function applyActiveProxySettings(): Promise<boolean> {
  proxySettingsUpdateQueue = proxySettingsUpdateQueue.then(() =>
    updateProxySettings(getActiveRequestTypes())
  );
  return proxySettingsUpdateQueue;
}

export default async function onContentScriptMessage(
  message: any,
  sender: Runtime.MessageSender
): Promise<void> {
  if (message.type === MessageType.EnableFullMode) {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const requestType = message.requestType as ProxyRequestType;
    const requestId = message.requestId as string;

    const timeoutMs = 10000;
    const timeout = setTimeout(() => {
      void (async () => {
        activeFullModeRequests.delete(requestId);
        if (isChromium) {
          await applyActiveProxySettings();
        }
        console.log(
          `Disabled full mode (request type: ${requestType}, timeout: ${timeoutMs}ms)`
        );
        try {
          await browser.tabs.sendMessage(tabId, {
            type: MessageType.DisableFullModeResponse,
            requestType,
            requestId,
            reason: "TIMEOUT",
          });
        } catch (error) {
          console.error(
            "Failed to send DisableFullModeResponse message",
            error
          );
        }
      })();
    }, timeoutMs);
    activeFullModeRequests.set(requestId, { requestType, timeout });

    let reason = "ENABLED";
    if (isChromium) {
      const applied = await applyActiveProxySettings();
      if (!applied) reason = "ERROR";
    }

    console.log(
      `Enabled full mode for ${timeoutMs}ms (request type: ${requestType})`
    );
    try {
      await browser.tabs.sendMessage(tabId, {
        type: MessageType.EnableFullModeResponse,
        requestType,
        requestId,
        reason,
      });
    } catch (error) {
      console.error("Failed to send EnableFullModeResponse message", error);
    }
  }

  if (message.type === MessageType.DisableFullMode) {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const requestType = message.requestType as ProxyRequestType;
    const fullModeRequestId = message.fullModeRequestId as string | undefined;

    if (fullModeRequestId) {
      const activeRequest = activeFullModeRequests.get(fullModeRequestId);
      if (activeRequest) clearTimeout(activeRequest.timeout);
      activeFullModeRequests.delete(fullModeRequestId);
    }
    if (isChromium) {
      await applyActiveProxySettings();
    }

    console.log(`Disabled full mode (request type: ${requestType})`);
    try {
      await browser.tabs.sendMessage(tabId, {
        type: MessageType.DisableFullModeResponse,
        requestType,
        requestId: message.requestId,
        reason: "DISABLED",
      });
    } catch (error) {
      console.error("Failed to send DisableFullModeResponse message", error);
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
