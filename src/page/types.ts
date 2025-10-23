import { Mutex } from "async-mutex";
import type { State } from "../store/types";
import { MessageType, ProxyRequestType } from "../types";

export type SendMessageFn = (message: any) => void;
export type SendMessageAndWaitForResponseFn = (
  scope: "page" | "worker",
  message: any,
  responseMessageType: MessageType,
  responseTimeout?: number
) => Promise<any>;

export interface PageState {
  params: any;
  isChromium: boolean;
  scope: "page" | "worker";
  state?: State;
  requestTypeMutexes: Record<ProxyRequestType, Mutex>;
  twitchWorkers: Worker[];
  sendMessageToContentScript: SendMessageFn;
  sendMessageToContentScriptAndWaitForResponse: SendMessageAndWaitForResponseFn;
  sendMessageToPageScript: SendMessageFn;
  sendMessageToPageScriptAndWaitForResponse: SendMessageAndWaitForResponseFn;
  sendMessageToWorkerScripts: SendMessageFn;
  sendMessageToWorkerScriptsAndWaitForResponse: SendMessageAndWaitForResponseFn;
}

export interface UsherManifest {
  channelName: string | null;
  assignedMap: Map<string, string>; // E.g. "720p60" -> "https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/..."
  replacementMap: Map<string, string> | null; // Same as above, but with new URLs.
  consecutiveMidrollResponses: number; // Used to avoid infinite loops.
  consecutiveMidrollCooldown: number; // Used to avoid infinite loops.
  deleted: boolean; // Deletion flag for cleanup.
}

export interface PlaybackAccessToken {
  value: string;
  signature: string;
  authorization: {
    isForbidden: boolean;
    forbiddenReasonCode: string;
  };
  __typename: string;
}
