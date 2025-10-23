import Logger from "../common/ts/Logger";
import toAbsoluteUrl from "../common/ts/toAbsoluteUrl";
import { MessageType } from "../types";
import type { PageState } from "./types";

const logger = new Logger("getWorker");

export default function getWorker(pageState: PageState): typeof Worker | null {
  // Check for other Twitch ad blockers at injection time.
  if (isUsingAnotherAdBlocker(window.Worker.prototype)) {
    logger.error("Another Twitch ad blocker is in use.");
    pageState.sendMessageToContentScript({
      type: MessageType.ExtensionError,
      errorMessage: "Another Twitch ad blocker is in use",
    });
    return null; // Do not replace Worker to avoid disabling the other ad blocker.
  }

  return class extends window.Worker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      const fullUrl = toAbsoluteUrl(scriptURL.toString());
      const isTwitchWorker = fullUrl.includes(".twitch.tv");
      if (!isTwitchWorker) {
        super(scriptURL, options);
        return;
      }
      // Check for other Twitch ad blockers at instantiation time (in case one was
      // injected after TTV LOL PRO).
      if (isUsingAnotherAdBlocker(window.Worker.prototype)) {
        logger.error("Another Twitch ad blocker is in use.");
        pageState.sendMessageToContentScript({
          type: MessageType.ExtensionError,
          errorMessage: "Another Twitch ad blocker is in use",
        });
        super(scriptURL, options);
        return;
      }
      let script = "";
      // Fetch Twitch's script, since Firefox Nightly errors out when trying to
      // import a blob URL directly.
      const xhr = new XMLHttpRequest();
      xhr.open("GET", fullUrl, false);
      xhr.send();
      if (200 <= xhr.status && xhr.status < 300) {
        script = xhr.responseText;
      } else {
        logger.warn(`Failed to fetch script: ${xhr.statusText}`);
        script = `importScripts('${fullUrl}');`; // Will fail on Firefox Nightly.
      }
      // ---------------------------------------
      // 🦊 Attention Firefox Addon Reviewer 🦊
      // ---------------------------------------
      // Please note that this does NOT involve remote code execution. The injected script is bundled
      // with the extension. Additionally, there is no custom Content Security Policy (CSP) in use.
      const newScript = `
      var getParams = () => '${JSON.stringify(pageState.params)}';
      try {
        importScripts('${pageState.params.workerScriptURL}');
      } catch (error) {
        console.error('[TTV LOL PRO] (getWorker) Failed to load script: ${
          pageState.params.workerScriptURL
        }:', error);
      }
      ${script}
    `;
      const newScriptURL = URL.createObjectURL(
        new Blob([newScript], { type: "text/javascript" })
      );
      // Required for VAFT (<9.0.0) compatibility.
      const wrapperScript = `
      try {
        importScripts('${newScriptURL}');
      } catch (error) {
        console.warn('[TTV LOL PRO] (getWorker) Failed to wrap script: ${newScriptURL}:', error);
        ${newScript}
      }
    `;
      const wrapperScriptURL = URL.createObjectURL(
        new Blob([wrapperScript], { type: "text/javascript" })
      );
      super(wrapperScriptURL, options);
      pageState.twitchWorkers.push(this);
      // Can't revoke `newScriptURL` because of a conflict with VAFT.
      URL.revokeObjectURL(wrapperScriptURL);
    }
  };
}

/**
 * Check if the worker's prototype chain contains known ad blocker code.
 * @param worker
 * @returns Whether another ad blocker is in use.
 */
function isUsingAnotherAdBlocker(worker: Worker): boolean {
  let proto = worker;
  while (proto) {
    const workerString = proto.toString();
    if (
      workerString.includes("twitch") &&
      (workerString.includes("getAdBlockDiv") ||
        workerString.includes("getAdDiv"))
    ) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
