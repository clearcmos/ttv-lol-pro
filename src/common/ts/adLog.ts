import store from "../../store";
import getHostFromUrl from "./getHostFromUrl";

/**
 * Resolve ad identity information for a given ad log entry index.
 * @param index
 * @param timeout
 * @returns True if the identity was successfully resolved or already exists, false otherwise.
 */
export async function resolveAdIdentity(
  index: number,
  timeout?: number
): Promise<boolean> {
  if (!(0 <= index && index < store.state.adLog.length)) return false;
  if (!store.state.adLog[index].parsedLine?.adLineItemId) return false;
  if (store.state.adLog[index].adIdentity) return true; // Already resolved.

  // Try to find existing identity in other log entries first.
  if (
    store.state.adLog[index].parsedLine.adDsaAdvertiserId != null &&
    store.state.adLog[index].parsedLine.adDsaCampaignId != null
  ) {
    const entry = store.state.adLog.find(
      e =>
        e.parsedLine?.adDsaAdvertiserId ===
          store.state.adLog[index].parsedLine?.adDsaAdvertiserId &&
        e.parsedLine?.adDsaCampaignId ===
          store.state.adLog[index].parsedLine?.adDsaCampaignId &&
        e.adIdentity !== undefined
    );
    if (entry) {
      store.state.adLog[index].adIdentity = entry.adIdentity;
      return true;
    }
  }
  const entry = store.state.adLog.find(
    e =>
      e.parsedLine?.adLineItemId ===
        store.state.adLog[index].parsedLine?.adLineItemId &&
      e.adIdentity !== undefined
  );
  if (entry) {
    store.state.adLog[index].adIdentity = entry.adIdentity;
    return true;
  }

  try {
    const response = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US",
        "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify([
        {
          operationName: "DSAWizard_Query",
          variables: {
            adInput: {
              adIDValue: store.state.adLog[index].parsedLine.adLineItemId,
              advertiserIDNS:
                store.state.adLog[index].parsedLine.adDsaAdvertiserId ?? "",
              campaignIDNS:
                store.state.adLog[index].parsedLine.adDsaCampaignId ?? "",
              selectionSignals: {},
            },
            clientInput: {},
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash:
                "09eb612f42f0d04651f837c7d1e8c7aa57a2cc9af0c075ce93eb16527b2dc67f",
            },
          },
        },
      ]),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    const json = await response.json();
    const adIdentity = json?.[0]?.["data"]?.["adIdentity"];
    if (adIdentity) {
      store.state.adLog[index].adIdentity = {
        advertiserName: adIdentity["advertiserName"],
        payerName: adIdentity["payerName"],
        isIdentityVerified: adIdentity["isIdentityVerified"],
      };
      return true;
    } else {
      store.state.adLog[index].adIdentity = null;
      return false;
    }
  } catch {}
  return false;
}

/**
 * Send ad log entries that haven't been sent yet to the server.
 * @returns True if the log was successfully sent, false if there was an error, or null if there were no new entries to send.
 */
export async function sendAdLog(): Promise<boolean | null> {
  const filteredAdLog = store.state.adLog
    .filter(entry => entry.timestamp > store.state.adLogLastSent)
    .map(entry => ({
      ...entry,
      videoWeaverUrl: getHostFromUrl(entry.videoWeaverUrl),
      rawLine: undefined,
    }));
  if (filteredAdLog.length === 0) return null; // No log entries to send.

  let success = false;
  try {
    const response = await fetch("https://perfprod.com/ttvlolpro/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ad-Log-Version": "2",
      },
      body: JSON.stringify(filteredAdLog),
    });
    success = response.ok;
    if (!success) console.error(`${response.status} ${response.statusText}`);
  } catch (error) {
    console.error(error);
  }

  if (success) store.state.adLogLastSent = Date.now();
  return success;
}
