// From https://stackoverflow.com/a/51419293
export type KeyOfType<T, V> = keyof {
  [P in keyof T as T[P] extends V ? P : never]: any;
};

// From https://www.charpeni.com/blog/properly-type-object-keys-and-object-entries#solution-1
export type ObjectEntries<T> = Array<[keyof T, T[keyof T]]>;

export type ProxyType = "direct" | "http" | "https" | "socks" | "socks4";

// From https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo
export interface ProxyInfo {
  type: ProxyType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  proxyDNS?: boolean;
  failoverTimeout?: number;
  proxyAuthorizationHeader?: string;
  connectionIsolationKey?: string;
}

export interface AdLogEntry {
  timestamp: number;
  channelName: string | null;
  videoWeaverUrl: string;
  rawLine: string;
  parsedLine?: {
    adRollType: "PREROLL" | "MIDROLL";
    adUrl: string;
    adClickTrackingUrl: string;
    adLineItemId: string;
    adCommercialId?: string;
  };
  adIdentity?: {
    advertiserName: string;
    payerName: string;
    isIdentityVerified: boolean;
  };
}

export interface StreamStatus {
  proxied: boolean;
  proxyHost?: string;
  proxyCountry?: string;
  reason: string;
  stats?: {
    proxied: number;
    notProxied: number;
  };
}

export interface DnsResponse {
  host: string;
  ips: string[];
  timestamp: number;
  ttl: number;
}

export interface DnsResponseJson {
  Status: number;
  TC: boolean; // Truncated
  RD: boolean; // Recursion Desired
  RA: boolean; // Recursion Available
  AD: boolean; // Authentic Data
  CD: boolean; // Checking Disabled
  Question: {
    name: string;
    type: number;
  }[];
  Answer: {
    name: string;
    type: number;
    TTL: number;
    data: string;
  }[];
}

export const enum MessageType {
  ContentScriptMessage = "TLP_ContentScriptMessage",
  PageScriptMessage = "TLP_PageScriptMessage",
  WorkerScriptMessage = "TLP_WorkerScriptMessage",
  GetStoreState = "TLP_GetStoreState",
  GetStoreStateResponse = "TLP_GetStoreStateResponse",
  EnableFullMode = "TLP_EnableFullMode",
  EnableFullModeResponse = "TLP_EnableFullModeResponse",
  DisableFullMode = "TLP_DisableFullMode",
  DisableFullModeResponse = "TLP_DisableFullModeResponse",
  UsherResponse = "TLP_UsherResponse",
  NewPlaybackAccessToken = "TLP_NewPlaybackAccessToken",
  NewPlaybackAccessTokenResponse = "TLP_NewPlaybackAccessTokenResponse",
  ChannelSubStatusChange = "TLP_ChannelSubStatusChange",
  UpdateAdLog = "TLP_UpdateAdLog",
  ClearStats = "TLP_ClearStats",
  ExtensionError = "TLP_ExtensionError",
}

export const enum ProxyRequestType {
  Passport = "passport",
  Usher = "usher",
  VideoWeaver = "videoWeaver",
  GraphQL = "graphQL",
  GraphQLToken = "graphQLToken",
  GraphQLIntegrity = "graphQLIntegrity",
  GraphQLAll = "graphQLAll",
  TwitchWebpage = "twitchWebpage",
}

export type ProxyRequestParams =
  | {
      isChromium: true;
      optimizedProxiesEnabled: boolean;
      passportLevel: number;
      customPassport: PassportConfig | null;
      fullModeEnabled?: boolean;
    }
  | {
      isChromium: false;
      optimizedProxiesEnabled: boolean;
      passportLevel: number;
      customPassport: PassportConfig | null;
      isFlagged?: boolean;
    };

export type PassportConfig = Record<
  Exclude<ProxyRequestType, ProxyRequestType.GraphQL>,
  boolean
>;

export type UserExperienceMode =
  | "blockAds"
  | "unlockBestQuality"
  | "expertMode";
