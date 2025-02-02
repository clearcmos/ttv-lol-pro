import store from "../../store";

export default function isChannelWhitelisted(
  channelName: string | null
): boolean {
  if (!channelName) return false;
  const channelNameLower = channelName.toLowerCase();
  return store.state.whitelistedChannels.some(
    c => c.toLowerCase() === channelNameLower
  );
}
