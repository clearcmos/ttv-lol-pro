import { MessageType } from "../types";
import type { SendMessageAndWaitForResponseFn, SendMessageFn } from "./types";

function sendMessage(
  broadcastChannel: BroadcastChannel,
  type: MessageType,
  message: any
): void {
  broadcastChannel.postMessage({
    type,
    message,
  });
}

async function sendMessageAndWaitForResponse(
  broadcastChannel: BroadcastChannel,
  type: MessageType,
  message: any,
  responseType: MessageType,
  responseMessageType: MessageType,
  responseTimeout: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (!event.data || event.data.type !== responseType) return;
      const { message } = event.data;
      if (!message) return;
      if (message.type === responseMessageType) {
        self.removeEventListener("message", listener);
        resolve(message);
      }
    };

    broadcastChannel.addEventListener("message", listener);
    broadcastChannel.postMessage({
      type,
      message,
      responseType,
      responseMessageType,
    });
    setTimeout(() => {
      self.removeEventListener("message", listener);
      reject(new Error("Timed out waiting for message response."));
    }, responseTimeout);
  });
}

export function getSendMessageToContentScript(
  broadcastChannel: BroadcastChannel
): SendMessageFn {
  return (message: any) =>
    sendMessage(broadcastChannel, MessageType.ContentScriptMessage, message);
}

export function getSendMessageToContentScriptAndWaitForResponse(
  broadcastChannel: BroadcastChannel
): SendMessageAndWaitForResponseFn {
  return async (
    scope: "page" | "worker",
    message: any,
    responseMessageType: MessageType,
    responseTimeout: number = 5000
  ) => {
    return sendMessageAndWaitForResponse(
      broadcastChannel,
      MessageType.ContentScriptMessage,
      message,
      scope === "page"
        ? MessageType.PageScriptMessage
        : MessageType.WorkerScriptMessage,
      responseMessageType,
      responseTimeout
    );
  };
}

export function getSendMessageToPageScript(
  broadcastChannel: BroadcastChannel
): SendMessageFn {
  return (message: any) =>
    sendMessage(broadcastChannel, MessageType.PageScriptMessage, message);
}

export function getSendMessageToPageScriptAndWaitForResponse(
  broadcastChannel: BroadcastChannel
): SendMessageAndWaitForResponseFn {
  return async (
    scope: "page" | "worker",
    message: any,
    responseMessageType: MessageType,
    responseTimeout: number = 5000
  ) => {
    return sendMessageAndWaitForResponse(
      broadcastChannel,
      MessageType.PageScriptMessage,
      message,
      scope === "page"
        ? MessageType.PageScriptMessage
        : MessageType.WorkerScriptMessage,
      responseMessageType,
      responseTimeout
    );
  };
}

export function getSendMessageToWorkerScripts(
  broadcastChannel: BroadcastChannel
): SendMessageFn {
  return (message: any) =>
    sendMessage(broadcastChannel, MessageType.WorkerScriptMessage, message);
}

export function getSendMessageToWorkerScriptsAndWaitForResponse(
  broadcastChannel: BroadcastChannel
): SendMessageAndWaitForResponseFn {
  return async (
    scope: "page" | "worker",
    message: any,
    responseMessageType: MessageType,
    responseTimeout: number = 5000
  ) => {
    return sendMessageAndWaitForResponse(
      broadcastChannel,
      MessageType.WorkerScriptMessage,
      message,
      scope === "page"
        ? MessageType.PageScriptMessage
        : MessageType.WorkerScriptMessage,
      responseMessageType,
      responseTimeout
    );
  };
}
