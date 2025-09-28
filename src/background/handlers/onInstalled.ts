import setupPageURL from "url:../../setup/page.html";
import browser, { Runtime } from "webextension-polyfill";
import store from "../../store";

export default async function onInstalled(
  details: Runtime.OnInstalledDetailsType
): Promise<void> {
  if (store.readyState !== "complete")
    return store.addEventListener("load", () => onInstalled(details));

  const isDevelopment = process.env.NODE_ENV === "development";
  if (!isDevelopment && details.reason === "install") {
    const currentSetupVersion = 1; // Careful! Increasing this number will trigger the setup page to open for everyone.
    if (store.state.completedSetupVersion < currentSetupVersion) {
      store.state.completedSetupVersion = currentSetupVersion;
      browser.tabs.create({
        url: `${setupPageURL}?reason=${details.reason}`,
      });
    }
  }
}
