export const TWITCH_URL_REGEX =
  /^https?:\/\/(?:www|m)\.twitch\.tv\/(?:videos\/|popout\/|moderator\/)?((?!(?:directory|downloads|jobs|p|privacy|search|settings|store|turbo)\b)\w+)/i;
export const TWITCH_API_URL_REGEX = /\/(hls|vod)\/(.+)\.m3u8(?:\?(.*))?$/i;
export const TTV_LOL_API_URL_REGEX = /\/(?:playlist|vod)\/(.+)\.m3u8/i;
