import pageScriptURL from "url:../page/page.ts";
import workerScriptURL from "url:../page/worker.ts";
import browser, { Storage } from "webextension-polyfill";
import { resolveAdIdentity } from "../common/ts/adLog";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import generateRandomString from "../common/ts/generateRandomString";
import isChannelWhitelisted from "../common/ts/isChannelWhitelisted";
import isChromium from "../common/ts/isChromium";
import Logger from "../common/ts/Logger";
import { getStreamStatus, setStreamStatus } from "../common/ts/streamStatus";
import store from "../store";
import type { State } from "../store/types";
import { MessageType } from "../types";

const logger = new Logger("Content");
logger.log("Content script running.");

const broadcastChannelName = `TLP_${generateRandomString(32)}`;
const broadcastChannel = new BroadcastChannel(broadcastChannelName);

injectPageScript();

if (store.readyState === "complete") onStoreLoad();
else store.addEventListener("load", onStoreLoad);
store.addEventListener("change", onStoreChange);

browser.runtime.onMessage.addListener(onBackgroundMessage);
broadcastChannel.addEventListener("message", onPageMessage);

function injectPageScript() {
  // From https://stackoverflow.com/a/9517879
  const script = document.createElement("script");
  script.src = pageScriptURL; // src/page/page.ts
  script.dataset.params = JSON.stringify({
    isChromium,
    workerScriptURL, // src/page/worker.ts
    broadcastChannelName,
  });
  script.onload = () => script.remove();
  // ---------------------------------------
  // 🦊 Attention Firefox Addon Reviewer 🦊
  // ---------------------------------------
  // Please note that this does NOT involve remote code execution. The injected scripts are bundled
  // with the extension. The `url:` imports above are used to get the runtime URLs of the respective scripts.
  // Additionally, there is no custom Content Security Policy (CSP) in use.
  (document.head || document.documentElement).prepend(script); // Note: Despite what the TS types say, `document.head` can be `null`.
}

function onStoreLoad() {
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
    message.type === MessageType.EnableFullModeResponse ||
    message.type === MessageType.DisableFullModeResponse
  ) {
    // Forward the message to the page script and worker script(s).
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

  if (message.type === MessageType.GetStoreState) {
    const sendStoreState = () => {
      broadcastChannel.postMessage({
        type: MessageType.PageScriptMessage,
        message: {
          type: MessageType.GetStoreStateResponse,
          state: JSON.parse(JSON.stringify(store.state)),
        },
      });
    };
    if (store.readyState === "complete") sendStoreState();
    else store.addEventListener("load", sendStoreState);
  }
  // ---
  else if (message.type === MessageType.EnableFullMode) {
    try {
      browser.runtime.sendMessage(message);
    } catch (error) {
      logger.error("Failed to send EnableFullMode message.", error);
    }
  }
  // ---
  else if (message.type === MessageType.DisableFullMode) {
    try {
      browser.runtime.sendMessage(message);
    } catch (error) {
      logger.error("Failed to send DisableFullMode message.", error);
    }
  }
  // ---
  else if (message.type === MessageType.UsherResponse) {
    try {
      browser.runtime.sendMessage(message);
    } catch (error) {
      logger.error("Failed to send UsherResponse message.", error);
    }
  }
  // ---
  else if (message.type === MessageType.ChannelSubStatusChange) {
    const { channelNameLower, wasSubscribed, isSubscribed } = message;
    const isWhitelisted = isChannelWhitelisted(channelNameLower);
    logger.log("Channel subscription status changed:", {
      channelNameLower,
      wasSubscribed,
      isSubscribed,
      isWhitelisted,
    });
    const currentChannelNameLower = findChannelFromTwitchTvUrl(
      location.href
    )?.toLowerCase();
    if (store.state.whitelistChannelSubscriptions && channelNameLower != null) {
      if (!wasSubscribed && isSubscribed) {
        store.state.activeChannelSubscriptions.push(channelNameLower);
        // Add to whitelist.
        if (!isWhitelisted) {
          store.state.whitelistedChannels.push(channelNameLower);
          logger.log(`Added '${channelNameLower}' to whitelist.`);
          if (channelNameLower === currentChannelNameLower) {
            location.reload();
          }
        }
      } else if (wasSubscribed && !isSubscribed) {
        store.state.activeChannelSubscriptions =
          store.state.activeChannelSubscriptions.filter(
            channel => channel.toLowerCase() !== channelNameLower
          );
        // Remove from whitelist.
        if (isWhitelisted) {
          store.state.whitelistedChannels =
            store.state.whitelistedChannels.filter(
              channel => channel.toLowerCase() !== channelNameLower
            );
          logger.log(`Removed '${channelNameLower}' from whitelist.`);
          if (channelNameLower === currentChannelNameLower) {
            location.reload();
          }
        }
      }
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
