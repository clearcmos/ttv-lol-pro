import workerScriptURL from "url:../page/worker.ts";
import browser, { Storage } from "webextension-polyfill";
import { resolveAdIdentity } from "../common/ts/adLog";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import generateRandomString from "../common/ts/generateRandomString";
import isChromium from "../common/ts/isChromium";
import Logger from "../common/ts/Logger";
import { getStreamStatus, setStreamStatus } from "../common/ts/streamStatus";
import type { PageState } from "../page/types";
import store from "../store";
import type { State } from "../store/types";
import { MessageType } from "../types";

const logger = new Logger("Content");
const performanceNavigationEntry =
  performance.getEntriesByType("navigation")[0];
if (performanceNavigationEntry) {
  logger.log(
    `Content script running (injected after ${(
      performance.now() - performanceNavigationEntry.startTime
    ).toFixed(0)}ms since navigation start).`
  );
} else {
  logger.log("Content script running.");
}

const broadcastChannelName = `TLP_${generateRandomString(32)}`;
const broadcastChannel = new BroadcastChannel(broadcastChannelName);

if (store.readyState === "complete") onStoreLoad();
else store.addEventListener("load", onStoreLoad);
store.addEventListener("change", onStoreChange);

browser.runtime.onMessage.addListener(onBackgroundMessage);
broadcastChannel.addEventListener("message", onPageMessage);

// Pass parameters to the page script.
document.documentElement.dataset.tlpParams = JSON.stringify({
  isChromium,
  workerScriptURL, // src/page/worker.ts
  broadcastChannelName,
});

function onStoreLoad() {
  // Send store state to page script and worker script(s).
  const state = JSON.parse(JSON.stringify(store.state));
  broadcastChannel.postMessage({
    type: MessageType.PageScriptMessage,
    message: {
      type: MessageType.GetStoreStateResponse,
      state,
    },
  });
  broadcastChannel.postMessage({
    type: MessageType.WorkerScriptMessage,
    message: {
      type: MessageType.GetStoreStateResponse,
      state,
    },
  });
  // Clear stats for stream on page load/reload.
  const channelName = findChannelFromTwitchTvUrl(location.href);
  clearStats(channelName);
}

/**
 * Clear stats for stream on page load/reload.
 * @param channelName
 * @param delayMs
 * @returns
 */
async function clearStats(channelName: string | null, delayMs?: number) {
  if (!channelName) return;
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  const channelNameLower = channelName.toLowerCase();
  if (store.state.streamStatuses.hasOwnProperty(channelNameLower)) {
    delete store.state.streamStatuses[channelNameLower];
  }
  logger.log(`Cleared stats for channel '${channelNameLower}'.`);
}

function onStoreChange(changes: Record<string, Storage.StorageChange>) {
  const changedKeys = Object.keys(changes) as (keyof State)[];
  // This is mainly to reduce the amount of messages sent to the page script.
  // (Also to reduce the number of console logs.)
  const ignoredKeys: (keyof State)[] = [
    "adLog",
    "dnsResponses",
    "openedTwitchTabs",
    "streamStatuses",
    "videoWeaverUrlsByChannel",
  ];
  if (changedKeys.every(key => ignoredKeys.includes(key))) return;
  logger.log("Store changed:", changes);
  broadcastChannel.postMessage({
    type: MessageType.PageScriptMessage,
    message: {
      type: MessageType.GetStoreStateResponse,
      state: JSON.parse(JSON.stringify(store.state)),
    },
  });
}

function onBackgroundMessage(message: any): undefined {
  if (!message || !message.type) return;

  if (
    [
      MessageType.EnableFullModeResponse,
      MessageType.DisableFullModeResponse,
    ].includes(message.type)
  ) {
    // Forward to page script and worker script(s).
    broadcastChannel.postMessage({
      type: MessageType.PageScriptMessage,
      message,
    });
    broadcastChannel.postMessage({
      type: MessageType.WorkerScriptMessage,
      message,
    });
  }
}

async function onPageMessage(event: MessageEvent) {
  if (!event.data || event.data.type !== MessageType.ContentScriptMessage) {
    return;
  }

  const { message } = event.data;
  if (!message) return;

  if (
    [
      MessageType.EnableFullMode,
      MessageType.DisableFullMode,
      MessageType.UsherResponse,
    ].includes(message.type)
  ) {
    // Forward to background script.
    try {
      browser.runtime.sendMessage(message);
    } catch (error) {
      logger.error(`Failed to send '${message.type}' message:`, error);
    }
    return;
  }

  if (store.readyState !== "complete") {
    // Wait for the store to be loaded.
    await new Promise<void>(resolve => {
      const listener = () => {
        store.removeEventListener("load", listener);
        resolve();
      };
      store.addEventListener("load", listener);
    });
  }

  if (message.type === MessageType.GetStoreState) {
    const state = JSON.parse(JSON.stringify(store.state));
    const from: PageState["scope"] | undefined = message.from;
    if (from !== "worker") {
      broadcastChannel.postMessage({
        type: MessageType.PageScriptMessage,
        message: {
          type: MessageType.GetStoreStateResponse,
          state,
          requestId: message.requestId,
        },
      });
    }
    if (from !== "page") {
      broadcastChannel.postMessage({
        type: MessageType.WorkerScriptMessage,
        message: {
          type: MessageType.GetStoreStateResponse,
          state,
          requestId: message.requestId,
        },
      });
    }
  }
  // ---
  else if (message.type === MessageType.UpdateAdLog) {
    const isDuplicate = store.state.adLog.some(entry => {
      if (entry.channelName !== message.channelName) return false;
      if (message.timestamp - entry.timestamp >= 60000) {
        return false; // Entry is too old to be a duplicate (more than 1 minute).
      }
      if (entry.parsedLine != null && message.parsedLine != null) {
        if (
          entry.parsedLine.adCommercialId != null &&
          message.parsedLine.adCommercialId != null
        ) {
          return (
            entry.parsedLine.adCommercialId ===
            message.parsedLine.adCommercialId
          );
        }
        return (
          entry.parsedLine.adLineItemId === message.parsedLine.adLineItemId
        );
      }
      return entry.videoWeaverUrl === message.videoWeaverUrl;
    });
    if (isDuplicate) return;
    store.state.adLog.push({
      timestamp: message.timestamp,
      channelName: message.channelName,
      videoWeaverUrl: message.videoWeaverUrl,
      rawLine: message.rawLine,
      parsedLine: message.parsedLine,
    });
    await resolveAdIdentity(store.state.adLog.length - 1, 3000);
    logger.log(
      `Ad log updated (${store.state.adLog.length} entries):`,
      store.state.adLog[store.state.adLog.length - 1]
    );
  }
  // ---
  else if (message.type === MessageType.ClearStats) {
    clearStats(message.channelName, 2000);
  }
  // ---
  else if (message.type === MessageType.ExtensionError) {
    const channelName = findChannelFromTwitchTvUrl(location.href);
    if (!channelName) return;
    const streamStatus = getStreamStatus(channelName);
    setStreamStatus(channelName, {
      ...(streamStatus ?? { proxied: false }),
      reason: message.errorMessage,
    });
  }
}
