import browser from "webextension-polyfill";
import $ from "../common/ts/$";
import setUserExperienceMode from "../common/ts/setUserExperienceMode";
import store from "../store";
import type { UserExperienceMode } from "../types";

const setupFormElement = $("#setup-form") as HTMLFormElement;
const expertModeSegmentElement = $("#expert-mode-segment") as HTMLDivElement;

if (store.readyState === "complete") init();
else store.addEventListener("load", init);

function init() {
  const experienceRadioNodeList = setupFormElement.elements.namedItem(
    "experience"
  ) as RadioNodeList | null;
  if (!experienceRadioNodeList) {
    const message = "Experience radio buttons not found in setup form.";
    console.error(message);
    alert(message);
    return;
  }
  experienceRadioNodeList.value = store.state.userExperienceMode;
  if (store.state.userExperienceMode === "expertMode") {
    expertModeSegmentElement.removeAttribute("hidden");
  }
}

setupFormElement.addEventListener("change", event => {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (event.target.name !== "experience") return;
  const experienceMode = event.target.value as UserExperienceMode;
  if (experienceMode === "expertMode") {
    expertModeSegmentElement.removeAttribute("hidden");
  }
  setUserExperienceMode(experienceMode);
});

setupFormElement.addEventListener("submit", async event => {
  event.preventDefault();
  // Close the current tab.
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs.length > 0) {
      browser.tabs.remove(tabs[0].id!);
    }
  } catch (error) {
    const message = `Failed to close the current tab: ${error}`;
    console.error(message);
    alert(message);
  }
});
