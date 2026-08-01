import store from "../../store";

export function removeAutomaticallyWhitelistedSubscriptions(
  whitelistedChannels: string[],
  activeChannelSubscriptions: string[]
): string[] {
  const subscriptions = new Set(
    activeChannelSubscriptions.map(channel => channel.toLowerCase())
  );
  return whitelistedChannels.filter(
    channel => !subscriptions.has(channel.toLowerCase())
  );
}

export default function disableSubscriptionAutoWhitelist(): void {
  if (store.readyState !== "complete") {
    store.addEventListener("load", disableSubscriptionAutoWhitelist);
    return;
  }

  const previousWhitelistLength = store.state.whitelistedChannels.length;
  store.state.whitelistedChannels = removeAutomaticallyWhitelistedSubscriptions(
    store.state.whitelistedChannels,
    store.state.activeChannelSubscriptions
  );
  store.state.activeChannelSubscriptions = [];
  store.state.whitelistChannelSubscriptions = false;

  const removedCount =
    previousWhitelistLength - store.state.whitelistedChannels.length;
  if (removedCount > 0) {
    console.info(
      `Removed ${removedCount} automatically whitelisted subscription(s).`
    );
  }
}
