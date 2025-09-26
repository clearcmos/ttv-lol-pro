import { Mutex } from "async-mutex";
import { MessageType, ProxyRequestType } from "../types";
import { getFetch } from "./getFetch";
import {
  getSendMessageToContentScript,
  getSendMessageToContentScriptAndWaitForResponse,
  getSendMessageToPageScript,
  getSendMessageToPageScriptAndWaitForResponse,
  getSendMessageToWorkerScripts,
  getSendMessageToWorkerScriptsAndWaitForResponse,
} from "./sendMessage";
import type { PageState } from "./types";

console.info("[TTV LOL PRO] Worker script running.");

declare var getParams: () => string;
let params;
try {
  params = JSON.parse(getParams()!);
} catch (error) {
  console.error("[TTV LOL PRO] Failed to parse params:", error);
}
getParams = undefined as any;

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
  isChromium: params.isChromium,
  scope: "worker",
  state: undefined,
  broadcastChannelName: params.broadcastChannelName,
  requestTypeMutexes: {
    [ProxyRequestType.Passport]: new Mutex(),
    [ProxyRequestType.Usher]: new Mutex(),
    [ProxyRequestType.VideoWeaver]: new Mutex(),
    [ProxyRequestType.GraphQL]: new Mutex(),
    [ProxyRequestType.GraphQLToken]: new Mutex(),
    [ProxyRequestType.GraphQLIntegrity]: new Mutex(),
    [ProxyRequestType.TwitchWebpage]: new Mutex(),
  },
  twitchWorkers: [], // Always empty in workers.
  sendMessageToContentScript,
  sendMessageToContentScriptAndWaitForResponse,
  sendMessageToPageScript,
  sendMessageToPageScriptAndWaitForResponse,
  sendMessageToWorkerScripts,
  sendMessageToWorkerScriptsAndWaitForResponse,
};

self.fetch = getFetch(pageState);

broadcastChannel.addEventListener("message", event => {
  if (!event.data || event.data.type !== MessageType.WorkerScriptMessage) {
    return;
  }

  const { message } = event.data;
  if (!message) return;

  switch (message.type) {
    case MessageType.GetStoreStateResponse: // From Page
      if (pageState.state == null) {
        console.log("[TTV LOL PRO] Received store state from page script.");
      } else {
        console.debug("[TTV LOL PRO] Received store state from page script.");
      }
      const state = message.state;
      pageState.state = state;
      break;
  }
});

sendMessageToPageScript({ type: MessageType.GetStoreState });
