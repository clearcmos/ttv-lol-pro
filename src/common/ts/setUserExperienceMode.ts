import store from "../../store";
import type { ObjectEntries, UserExperienceMode } from "../../types";
import isChromium from "./isChromium";
import { updateProxySettings } from "./proxySettings";

/**
 * Safely set the user experience mode and override options accordingly.
 * @param experienceMode
 */
export default function setUserExperienceMode(
  experienceMode: UserExperienceMode
) {
  if (experienceMode === store.state.userExperienceMode) return;

  // Restore overridden options to the state.
  const typedEntries = Object.entries(
    store.state.userExperienceOverridenOptions
  ) as ObjectEntries<typeof store.state.userExperienceOverridenOptions>;
  for (const [key, value] of typedEntries) {
    if (key in store.state && value !== undefined) {
      (store.state as any)[key] = value;
    }
  }
  store.state.userExperienceOverridenOptions = {};

  switch (experienceMode) {
    case "blockAds":
      store.state.customPassportEnabled = false;
      break;
    case "unlockBestQuality":
      store.state.customPassportEnabled = true;
      // Backup options to be overridden.
      store.state.userExperienceOverridenOptions = {
        adLogEnabled: store.state.adLogEnabled,
        anonymousMode: store.state.anonymousMode,
        customPassport: store.state.customPassport,
        whitelistChannelSubscriptions:
          store.state.whitelistChannelSubscriptions,
      };
      store.state.adLogEnabled = false;
      store.state.anonymousMode = false;
      store.state.customPassport = {
        passport: false,
        usher: true,
        videoWeaver: false,
        graphQLToken: true,
        graphQLIntegrity: false,
        graphQLAll: false,
        twitchWebpage: false,
      };
      store.state.whitelistChannelSubscriptions = false;
      break;
    case "expertMode":
      store.state.customPassportEnabled = true;
      break;
  }

  store.state.userExperienceMode = experienceMode;
  if (isChromium && store.state.chromiumProxyActive) {
    updateProxySettings();
  }
}
