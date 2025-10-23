import { Mutex } from "async-mutex";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import toAbsoluteUrl from "../common/ts/toAbsoluteUrl";
import { MessageType, ProxyRequestType } from "../types";
import getFetch from "./getFetch";
import getWorker from "./getWorker";
import {
  getSendMessageToContentScript,
  getSendMessageToContentScriptAndWaitForResponse,
  getSendMessageToPageScript,
  getSendMessageToPageScriptAndWaitForResponse,
  getSendMessageToWorkerScripts,
  getSendMessageToWorkerScriptsAndWaitForResponse,
} from "./sendMessage";
import type { PageState } from "./types";

console.info("[TTV LOL PRO] Page script running.");

let params;
try {
  params = JSON.parse(document.currentScript!.dataset.params!);
} catch (error) {
  console.error("[TTV LOL PRO] Failed to parse params:", error);
}
delete document.currentScript!.dataset.params;

const broadcastChannel = new BroadcastChannel(params.broadcastChannelName);
const sendMessageToContentScript =
  getSendMessageToContentScript(broadcastChannel);
const sendMessageToContentScriptAndWaitForResponse =
  getSendMessageToContentScriptAndWaitForResponse(broadcastChannel);
const sendMessageToPageScript = getSendMessageToPageScript(broadcastChannel);
const sendMessageToPageScriptAndWaitForResponse =
  getSendMessageToPageScriptAndWaitForResponse(broadcastChannel);
const sendMessageToWorkerScripts =
  getSendMessageToWorkerScripts(broadcastChannel);
const sendMessageToWorkerScriptsAndWaitForResponse =
  getSendMessageToWorkerScriptsAndWaitForResponse(broadcastChannel);

const pageState: PageState = {
  params: params,
  isChromium: params.isChromium,
  scope: "page",
  state: undefined,
  requestTypeMutexes: {
    [ProxyRequestType.Passport]: new Mutex(),
    [ProxyRequestType.Usher]: new Mutex(),
    [ProxyRequestType.VideoWeaver]: new Mutex(),
    [ProxyRequestType.GraphQL]: new Mutex(),
    [ProxyRequestType.GraphQLToken]: new Mutex(),
    [ProxyRequestType.GraphQLIntegrity]: new Mutex(),
    [ProxyRequestType.GraphQLAll]: new Mutex(),
    [ProxyRequestType.TwitchWebpage]: new Mutex(),
  },
  twitchWorkers: [], // No longer used. Might be useful in the future?
  sendMessageToContentScript,
  sendMessageToContentScriptAndWaitForResponse,
  sendMessageToPageScript,
  sendMessageToPageScriptAndWaitForResponse,
  sendMessageToWorkerScripts,
  sendMessageToWorkerScriptsAndWaitForResponse,
};

const newFetch = getFetch(pageState);
window.fetch = newFetch;
if (window.fetch !== newFetch) {
  console.error("[TTV LOL PRO] Failed to replace fetch.");
  sendMessageToContentScript({
    type: MessageType.ExtensionError,
    errorMessage:
      "Failed to replace fetch. Are you using another Twitch extension?",
  });
} else {
  console.debug("[TTV LOL PRO] fetch replaced successfully.");
}

const newWorker = getWorker(pageState);
if (newWorker !== null) {
  window.Worker = newWorker;
  if (window.Worker !== newWorker) {
    console.error("[TTV LOL PRO] Failed to replace Worker.");
    sendMessageToContentScript({
      type: MessageType.ExtensionError,
      errorMessage:
        "Failed to replace Worker. Are you using another Twitch ad blocker?",
    });
  } else {
    console.debug("[TTV LOL PRO] Worker replaced successfully.");
  }
}

let sendStoreStateToWorker = false;
broadcastChannel.addEventListener("message", event => {
  if (!event.data || event.data.type !== MessageType.PageScriptMessage) {
    return;
  }

  const { message } = event.data;
  if (!message) return;

  switch (message.type) {
    case MessageType.GetStoreState: // From Worker
      if (pageState.state != null) {
        sendMessageToWorkerScripts({
          type: MessageType.GetStoreStateResponse,
          state: pageState.state,
        });
      }
      sendStoreStateToWorker = true;
      break;
    case MessageType.GetStoreStateResponse: // From Content
      if (pageState.state == null) {
        console.log("[TTV LOL PRO] Received store state from content script.");
      } else {
        console.debug(
          "[TTV LOL PRO] Received store state from content script."
        );
      }
      const state = message.state;
      pageState.state = state;
      if (sendStoreStateToWorker) {
        sendMessageToWorkerScripts({
          type: MessageType.GetStoreStateResponse,
          state,
        });
      }
      break;
  }
});
sendMessageToContentScript({ type: MessageType.GetStoreState });

function onChannelChange(
  callback: (channelName: string, oldChannelName: string | null) => void
) {
  let channelName: string | null = findChannelFromTwitchTvUrl(location.href);

  const NATIVE_PUSH_STATE = window.history.pushState;
  function pushState(
    data: any,
    unused: string,
    url?: string | URL | null | undefined
  ) {
    if (!url) return NATIVE_PUSH_STATE.call(window.history, data, unused);
    const fullUrl = toAbsoluteUrl(url.toString());
    const newChannelName = findChannelFromTwitchTvUrl(fullUrl);
    if (newChannelName != null && newChannelName !== channelName) {
      const oldChannelName = channelName;
      channelName = newChannelName;
      callback(channelName, oldChannelName);
    }
    return NATIVE_PUSH_STATE.call(window.history, data, unused, url);
  }
  window.history.pushState = pushState;

  const NATIVE_REPLACE_STATE = window.history.replaceState;
  function replaceState(
    data: any,
    unused: string,
    url?: string | URL | null | undefined
  ) {
    if (!url) return NATIVE_REPLACE_STATE.call(window.history, data, unused);
    const fullUrl = toAbsoluteUrl(url.toString());
    const newChannelName = findChannelFromTwitchTvUrl(fullUrl);
    if (newChannelName != null && newChannelName !== channelName) {
      const oldChannelName = channelName;
      channelName = newChannelName;
      callback(channelName, oldChannelName);
    }
    return NATIVE_REPLACE_STATE.call(window.history, data, unused, url);
  }
  window.history.replaceState = replaceState;

  window.addEventListener("popstate", () => {
    const newChannelName = findChannelFromTwitchTvUrl(location.href);
    if (newChannelName != null && newChannelName !== channelName) {
      const oldChannelName = channelName;
      channelName = newChannelName;
      callback(channelName, oldChannelName);
    }
  });
}
onChannelChange((_channelName, oldChannelName) => {
  sendMessageToContentScript({
    type: MessageType.ClearStats,
    channelName: oldChannelName,
  });
  sendMessageToPageScript({
    type: MessageType.ClearStats,
    channelName: oldChannelName,
  });
  sendMessageToWorkerScripts({
    type: MessageType.ClearStats,
    channelName: oldChannelName,
  });
});

document.currentScript!.remove();
