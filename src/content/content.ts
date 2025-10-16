import pageScriptURL from "url:../page/page.ts";
import workerScriptURL from "url:../page/worker.ts";
import browser, { Storage } from "webextension-polyfill";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import generateRandomString from "../common/ts/generateRandomString";
import isChannelWhitelisted from "../common/ts/isChannelWhitelisted";
import isChromium from "../common/ts/isChromium";
import { getStreamStatus, setStreamStatus } from "../common/ts/streamStatus";
import store from "../store";
import type { State } from "../store/types";
import { AdLogEntry, MessageType } from "../types";

console.info("[TTV LOL PRO] Content script running.");

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
  console.log(
    `[TTV LOL PRO] Cleared stats for channel '${channelNameLower}' (content script).`
  );
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
  console.log("[TTV LOL PRO] Store changed:", changes);
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

function onPageMessage(event: MessageEvent) {
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
      console.error(
        "[TTV LOL PRO] Failed to send EnableFullMode message",
        error
      );
    }
  }
  // ---
  else if (message.type === MessageType.DisableFullMode) {
    try {
      browser.runtime.sendMessage(message);
    } catch (error) {
      console.error(
        "[TTV LOL PRO] Failed to send DisableFullMode message",
        error
      );
    }
  }
  // ---
  else if (message.type === MessageType.ChannelSubStatusChange) {
    const { channelNameLower, wasSubscribed, isSubscribed } = message;
    const isWhitelisted = isChannelWhitelisted(channelNameLower);
    console.log("[TTV LOL PRO] ChannelSubStatusChange", {
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
          console.log(
            `[TTV LOL PRO] Adding '${channelNameLower}' to whitelist.`
          );
          store.state.whitelistedChannels.push(channelNameLower);
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
          console.log(
            `[TTV LOL PRO] Removing '${channelNameLower}' from whitelist.`
          );
          store.state.whitelistedChannels =
            store.state.whitelistedChannels.filter(
              channel => channel.toLowerCase() !== channelNameLower
            );
          if (channelNameLower === currentChannelNameLower) {
            location.reload();
          }
        }
      }
    }
  }
  // ---
  else if (message.type === MessageType.UsherResponse) {
    try {
      browser.runtime.sendMessage(message);
    } catch (error) {
      console.error(
        "[TTV LOL PRO] Failed to send UsherResponse message",
        error
      );
    }
  }
  // ---
  else if (message.type === MessageType.MultipleAdBlockersInUse) {
    const channelName = findChannelFromTwitchTvUrl(location.href);
    if (!channelName) return;
    const streamStatus = getStreamStatus(channelName);
    setStreamStatus(channelName, {
      ...(streamStatus ?? { proxied: false }),
      reason: "Another Twitch ad blocker is in use",
    });
  }
  // ---
  else if (message.type === MessageType.ClearStats) {
    clearStats(message.channelName, 2000);
  }
  // ---
  else if (message.type === MessageType.UpdateAdLog) {
    const isDuplicate = store.state.adLog.some(
      entry =>
        entry.videoWeaverUrl === message.videoWeaverUrl &&
        message.timestamp - entry.timestamp < 1000 * 30 // 30 seconds
    );
    if (isDuplicate) return;
    const entry: AdLogEntry = {
      timestamp: message.timestamp,
      channelName: message.channelName,
      videoWeaverUrl: message.videoWeaverUrl,
      rawLine: message.rawLine,
      parsedLine: message.parsedLine,
    };
    store.state.adLog.push(entry);
    if (store.state.adLog.length > 100) {
      // Keep only the last 100 entries.
      store.state.adLog.splice(0, store.state.adLog.length - 100);
    }
    console.log(
      `[TTV LOL PRO] Ad log updated (${store.state.adLog.length} entries).`,
      entry
    );
  }
}
