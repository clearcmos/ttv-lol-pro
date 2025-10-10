import { ProxyRequestParams, ProxyRequestType } from "../../types";

export default function isRequestTypeProxied(
  type: ProxyRequestType,
  params: ProxyRequestParams
): boolean {
  // TODO: Align passport level logic between Chromium and Firefox.

  if (type === ProxyRequestType.Passport) {
    if (params.isChromium && !params.optimizedProxiesEnabled) {
      return params.customPassport?.passport ?? params.passportLevel >= 0;
    } else {
      return params.customPassport?.passport ?? params.passportLevel >= 1;
    }
  }

  if (type === ProxyRequestType.Usher) {
    if (params.optimizedProxiesEnabled) {
      if (params.isChromium && params.fullModeEnabled === false) {
        return false;
      }
      if (!params.isChromium && params.isFlagged === false) {
        return false;
      }
    }
    return params.customPassport?.usher ?? params.passportLevel >= 0;
  }

  if (type === ProxyRequestType.VideoWeaver) {
    if (params.optimizedProxiesEnabled) {
      if (params.isChromium && params.fullModeEnabled === false) {
        return false;
      }
      if (!params.isChromium && params.isFlagged === false) {
        return false;
      }
    }
    return params.customPassport?.videoWeaver ?? params.passportLevel >= 0;
  }

  if (type === ProxyRequestType.GraphQLToken) {
    if (params.isChromium) {
      return params.customPassport?.graphQLToken ?? params.passportLevel >= 1;
    } else {
      return params.customPassport?.graphQLToken ?? params.passportLevel >= 0;
    }
  }

  if (type === ProxyRequestType.GraphQLIntegrity) {
    if (params.optimizedProxiesEnabled) {
      return (
        params.customPassport?.graphQLIntegrity ?? params.passportLevel >= 2
      );
    } else {
      return (
        params.customPassport?.graphQLIntegrity ?? params.passportLevel >= 1
      );
    }
  }

  if (type === ProxyRequestType.GraphQLAll) {
    if (!params.optimizedProxiesEnabled) {
      if (
        params.isChromium &&
        (params.customPassport?.graphQLAll ?? params.passportLevel >= 1)
      ) {
        return true;
      }
      if (
        !params.isChromium &&
        (params.customPassport?.graphQLAll ?? params.passportLevel >= 2)
      ) {
        return true;
      }
    }
    return false;
  }

  if (type === ProxyRequestType.GraphQL) {
    if (isRequestTypeProxied(ProxyRequestType.GraphQLAll, params)) {
      return true;
    }
    if (params.isChromium && params.fullModeEnabled === false) {
      return false;
    }
    if (!params.isChromium && params.isFlagged === false) {
      return false;
    }
    return (
      isRequestTypeProxied(ProxyRequestType.GraphQLToken, params) ||
      isRequestTypeProxied(ProxyRequestType.GraphQLIntegrity, params)
    );
  }

  if (type === ProxyRequestType.TwitchWebpage) {
    return params.customPassport?.twitchWebpage ?? params.passportLevel >= 2;
  }

  return false;
}
