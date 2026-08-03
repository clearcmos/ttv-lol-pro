import * as m3u8Parser from "m3u8-parser";
import acceptFlag from "../common/ts/acceptFlag";
import findChannelFromTwitchTvUrl from "../common/ts/findChannelFromTwitchTvUrl";
import findChannelFromUsherUrl from "../common/ts/findChannelFromUsherUrl";
import generateRandomString, {
  Charset,
} from "../common/ts/generateRandomString";
import getHostFromUrl from "../common/ts/getHostFromUrl";
import isRequestTypeProxied from "../common/ts/isRequestTypeProxied";
import Logger from "../common/ts/Logger";
import {
  twitchGqlHostRegex,
  usherHostRegex,
  videoWeaverHostRegex,
} from "../common/ts/regexes";
import { MessageType, ProxyRequestType } from "../types";
import {
  AdReplacementCoordinator,
  handleDetectedAd,
} from "./adReplacementCoordinator";
import type { PageState, PlaybackAccessToken, UsherManifest } from "./types";

const NATIVE_FETCH = self.fetch;
const logger = new Logger("fetch");
const AD_REPLACEMENT_MAX_ATTEMPTS = 2;
const AD_REPLACEMENT_RETRY_DELAY_MS = 250;
const AD_REPLACEMENT_FAILURE_BACKOFF_MS = 2_000;

interface VideoWeaverReplacement {
  replacementMap: Map<string, string>;
  videoWeaverUrls: string[];
}

export default function getFetch(pageState: PageState): typeof fetch {
  const broadcastChannel = new BroadcastChannel(
    pageState.params.broadcastChannelName
  );

  let usherManifests: UsherManifest[] = [];
  let videoWeaverUrlsProxiedCount = new Map<string, number>(); // Used to count how many times each Video Weaver URL was proxied.
  let videoWeaverUrlsToNotProxy = new Set<string>(); // Used to avoid proxying frontpage or whitelisted Video Weaver URLs.
  const adReplacementCoordinator =
    new AdReplacementCoordinator<VideoWeaverReplacement>({
      maxAttempts: AD_REPLACEMENT_MAX_ATTEMPTS,
      retryDelayMs: AD_REPLACEMENT_RETRY_DELAY_MS,
      failureBackoffMs: AD_REPLACEMENT_FAILURE_BACKOFF_MS,
      onAttemptFailure: (error, attempt) => {
        logger.warn(
          `Ad replacement attempt ${attempt}/${AD_REPLACEMENT_MAX_ATTEMPTS} failed: ${getErrorMessage(error)}`
        );
      },
    });

  let cachedPlaybackTokenRequestHeaders: Map<string, string> | null = null; // Cached by page script.
  let cachedPlaybackTokenRequestBody: string | null = null; // Cached by page script.
  let cachedUsherRequestUrl: string | null = null; // Cached by worker script.

  // Listen for NewPlaybackAccessToken messages from the worker script.
  if (pageState.scope === "page") {
    broadcastChannel.addEventListener("message", async event => {
      if (!event.data || event.data.type !== MessageType.PageScriptMessage) {
        return;
      }

      const { message } = event.data;
      if (!message) return;

      switch (message.type) {
        case MessageType.NewPlaybackAccessToken:
          await waitForStore(pageState);
          const newPlaybackAccessToken =
            await fetchReplacementPlaybackAccessToken(
              pageState,
              cachedPlaybackTokenRequestHeaders,
              cachedPlaybackTokenRequestBody,
              message.isFlaggedRequestOverride
            );
          pageState.sendMessageToWorkerScripts({
            type: MessageType.NewPlaybackAccessTokenResponse,
            newPlaybackAccessToken,
            requestId: message.requestId,
          });
          break;
      }
    });
  }

  // Listen for messages from the content or page script.
  broadcastChannel.addEventListener("message", async event => {
    if (
      !event.data ||
      (pageState.scope === "page" &&
        event.data.type !== MessageType.PageScriptMessage) ||
      (pageState.scope === "worker" &&
        event.data.type !== MessageType.WorkerScriptMessage)
    ) {
      return;
    }

    const { message } = event.data;
    if (!message) return;

    switch (message.type) {
      case MessageType.ClearStats:
        logger.log("Cleared stats.");
        if (!message.channelName) break;
        const channelNameLower = message.channelName.toLowerCase();
        for (let i = 0; i < usherManifests.length; i++) {
          if (
            usherManifests[i].channelName?.toLowerCase() === channelNameLower
          ) {
            usherManifests[i].deleted = true;
          }
        }
        if (cachedPlaybackTokenRequestBody?.includes(channelNameLower)) {
          cachedPlaybackTokenRequestHeaders = null;
          cachedPlaybackTokenRequestBody = null;
        }
        if (cachedUsherRequestUrl?.includes(channelNameLower)) {
          cachedUsherRequestUrl = null;
        }
        break;
      case MessageType.DisableFullModeResponse:
        await waitForStore(pageState);
        if (
          pageState.isChromium &&
          (pageState.state?.optimizedProxiesEnabled ?? true) &&
          message.reason === "TIMEOUT"
        ) {
          const requestType = message.requestType as ProxyRequestType;
          const mutex = pageState.requestTypeMutexes[requestType];
          if (mutex.isLocked()) {
            mutex.release();
            logger.debug(`🔓 Unlocked '${requestType}' (timeout)`);
          }
        }
        break;
    }
  });

  // // Test Video Weaver URL replacement.
  // const isDevelopment = process.env.NODE_ENV === "development";
  // if (isDevelopment && pageState.scope === "worker") {
  //   setTimeout(async () => {
  //     await waitForStore(pageState);
  //     try {
  //       const videoWeaverUrls = await updateVideoWeaverReplacementMap(
  //         pageState,
  //         cachedUsherRequestUrl,
  //         usherManifests[usherManifests.length - 1]
  //       );
  //       logger.log(
  //         "Test Video Weaver URL replacement successful:",
  //         videoWeaverUrls
  //       );
  //     } catch (error) {
  //       logger.error("Test Video Weaver URL replacement failed:", error);
  //     }
  //   }, 30000);
  // }

  return async function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : input.toString();
    // Firefox doesn't support relative URLs in content scripts (workers too!).
    // See https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#content_script_https_requests
    if (url.startsWith("//")) {
      // Missing protocol.
      const newUrl = `${location.protocol}${url}`;
      if (input instanceof Request) input = new Request(newUrl, input);
      else input = newUrl;
    } else if (url.startsWith("/")) {
      // Missing origin.
      const newUrl = `${location.origin}${url}`;
      if (input instanceof Request) input = new Request(newUrl, input);
      else input = newUrl;
    }
    const host = getHostFromUrl(url);
    const headersMap = getHeadersMap(input, init);

    let isFlaggedRequest = false; // Whether or not the request should be proxied.
    let request: Request | null = null; // Request can be overwritten.
    let requestType: ProxyRequestType | null = null;
    let splitRequest: Request | null = null; // Part of a flagged request that should not be proxied.
    let splitIndexMap: [Map<number, number>, Map<number, number>] | null = null; // Used to sort split queries back to original order.

    // Reading the request body can be expensive, so we only do it if we need to.
    let requestBody: string | null | undefined = undefined;
    const readRequestBody = async (): Promise<string | null> => {
      if (requestBody !== undefined) return requestBody;
      return getRequestBodyText(input, init);
    };

    //#region Requests

    // Twitch GraphQL requests.
    graphqlReq: if (host != null && twitchGqlHostRegex.test(host)) {
      requestType = ProxyRequestType.GraphQL;

      const isIntegrityRequest = url === "https://gql.twitch.tv/integrity";
      const isIntegrityHeaderRequest =
        getHeaderFromMap(headersMap, "Client-Integrity") != null;

      //#region GraphQL PlaybackAccessToken requests.
      requestBody ??= await readRequestBody();
      if (requestBody != null && requestBody.includes("PlaybackAccessToken")) {
        let graphQlBody = null;
        try {
          graphQlBody = JSON.parse(requestBody);
        } catch (error) {
          logger.error("Failed to parse GraphQL request body:", error);
          break graphqlReq;
        }
        const isGraphQlBodyArray = Array.isArray(graphQlBody);
        if (!isGraphQlBodyArray) {
          // Cache the request headers and body for later use.
          cachedPlaybackTokenRequestHeaders = headersMap;
          cachedPlaybackTokenRequestBody = requestBody;
        }

        await waitForStore(pageState);
        const allQueries = isGraphQlBodyArray ? graphQlBody : [graphQlBody];
        const [tokenQueries, otherQueries] = partitionMap(
          allQueries,
          (query: any) => query?.operationName?.includes("PlaybackAccessToken")
        );
        let [tokenQueriesToProxy, tokenQueriesNotToProxy] = partitionMap(
          tokenQueries,
          (query: any) => {
            const channelName = query?.variables?.login as string | undefined;
            if (!channelName) return false;
            const isLivestream = !/^\d+$/.test(channelName); // VODs have numeric IDs.
            const isFrontpage = query?.variables?.playerType === "frontpage";
            const isWhitelisted = isChannelWhitelisted(channelName, pageState);
            return isLivestream && !isFrontpage && !isWhitelisted;
          }
        );
        if (tokenQueriesToProxy.size === 0) {
          logger.log(
            "Not flagging *PlaybackAccessToken* request: not a livestream, is frontpage, or is whitelisted."
          );
          break graphqlReq;
        }

        const areIntegrityRequestsProxied = isRequestTypeProxied(
          ProxyRequestType.GraphQLIntegrity,
          {
            isChromium: pageState.isChromium,
            optimizedProxiesEnabled:
              pageState.state?.optimizedProxiesEnabled ?? true,
            passportLevel: pageState.state?.passportLevel ?? 0,
            customPassport: pageState.state?.customPassportEnabled
              ? pageState.state.customPassport
              : null,
          }
        );
        let willFailIntegrityCheckIfProxied =
          isIntegrityHeaderRequest && !areIntegrityRequestsProxied;
        const shouldFlagRequest = isRequestTypeProxied(
          ProxyRequestType.GraphQLToken,
          {
            isChromium: pageState.isChromium,
            optimizedProxiesEnabled:
              pageState.state?.optimizedProxiesEnabled ?? true,
            passportLevel: pageState.state?.passportLevel ?? 0,
            customPassport: pageState.state?.customPassportEnabled
              ? pageState.state.customPassport
              : null,
          }
        );
        const shouldOverrideRequest =
          pageState.state?.anonymousMode === true ||
          (shouldFlagRequest && willFailIntegrityCheckIfProxied);
        if (shouldOverrideRequest) {
          logger.log("Overriding *PlaybackAccessToken* request…");
          if (shouldFlagRequest && willFailIntegrityCheckIfProxied) {
            const setHeaderToMapIfNotExists = (name: string, value: string) => {
              if (getHeaderFromMap(headersMap, name) == null) {
                setHeaderToMap(headersMap, name, value);
              }
            };
            // Map token queries requiring integrity checks to template ones.
            let mappedSome = false;
            tokenQueriesToProxy.forEach((query: any, key: number) => {
              // If Twitch starts enforcing integrity checks on
              // PrefetchPlaybackAccessToken, add it to the list below.
              const operationsRequiringIntegrityCheck = ["PlaybackAccessToken"];
              if (
                operationsRequiringIntegrityCheck.includes(query.operationName)
              ) {
                const channelName = query.variables.login as string;
                const { query: gqlQuery, headersMap: gqlHeadersMap } =
                  getDefaultPlaybackAccessTokenQueryAndHeaders(
                    channelName,
                    pageState.state?.anonymousMode === true,
                    query.variables.playerType
                  );
                tokenQueriesToProxy.set(key, gqlQuery);
                gqlHeadersMap.forEach((value, name) => {
                  setHeaderToMapIfNotExists(name, value);
                });
                mappedSome = true;
              }
            });
            if (mappedSome) {
              logger.debug("Mapped to PlaybackAccessToken_Template queries:", [
                ...tokenQueriesToProxy.values(),
              ]);
            }
            removeHeaderFromMap(headersMap, "Client-Integrity");
            willFailIntegrityCheckIfProxied = false;
          }
          const setHeaderToMapIfExists = (name: string, value: string) => {
            if (getHeaderFromMap(headersMap, name) != null) {
              setHeaderToMap(headersMap, name, value);
            }
          };
          if (pageState.state?.anonymousMode === true) {
            setHeaderToMapIfExists("Authorization", "undefined");
          }
          setHeaderToMapIfExists(
            "Client-Session-Id",
            generateRandomString(16, Charset.ALPHANUMERIC_LOWERCASE)
          );
          setHeaderToMapIfExists("Device-ID", generateRandomString(32));
          setHeaderToMapIfExists("X-Device-Id", generateRandomString(32));
        }

        if (shouldFlagRequest && !willFailIntegrityCheckIfProxied) {
          // Split the request if it contains non-proxied queries.
          if (tokenQueriesToProxy.size !== allQueries.length) {
            logger.log(
              "Splitting *PlaybackAccessToken* request into proxied and non-proxied requests…"
            );
            // Current request becomes the proxied request.
            request = new Request(url, {
              ...init,
              headers: Object.fromEntries(headersMap),
              // Splitting logic requires array body even for single queries.
              body: JSON.stringify([...tokenQueriesToProxy.values()]),
            });
            // Split request becomes the non-proxied request.
            splitRequest = new Request(url, {
              ...init,
              body: JSON.stringify([
                ...tokenQueriesNotToProxy.values(),
                ...otherQueries.values(),
              ]),
            });
            splitIndexMap = [
              new Map(
                [...tokenQueriesToProxy.keys()].map((originalIndex, index) => [
                  index,
                  originalIndex,
                ])
              ),
              new Map(
                [...tokenQueriesNotToProxy.keys(), ...otherQueries.keys()].map(
                  (originalIndex, index) => [index, originalIndex]
                )
              ),
            ];
          }

          logger.log("Flagging *PlaybackAccessToken* request…");
          isFlaggedRequest = true;
        }
        break graphqlReq;
      }
      //#endregion

      //#region GraphQL integrity requests.
      if (isIntegrityRequest || isIntegrityHeaderRequest) {
        await waitForStore(pageState);
        const shouldFlagRequest = isRequestTypeProxied(
          ProxyRequestType.GraphQLIntegrity,
          {
            isChromium: pageState.isChromium,
            optimizedProxiesEnabled:
              pageState.state?.optimizedProxiesEnabled ?? true,
            passportLevel: pageState.state?.passportLevel ?? 0,
            customPassport: pageState.state?.customPassportEnabled
              ? pageState.state.customPassport
              : null,
          }
        );
        if (shouldFlagRequest) {
          if (isIntegrityRequest) {
            logger.debug("Flagging GraphQL integrity request…");
            isFlaggedRequest = true;
          } else if (isIntegrityHeaderRequest) {
            logger.debug(
              "Flagging GraphQL request with Client-Integrity header…"
            );
            isFlaggedRequest = true;
          }
        }
        break graphqlReq;
      }
      //#endregion
    }

    // Twitch Usher requests.
    usherReq: if (host != null && usherHostRegex.test(host)) {
      requestType = ProxyRequestType.Usher;

      cachedUsherRequestUrl = url; // Cache the URL for later use.

      await waitForStore(pageState);
      const isLivestream = !url.includes("/vod/");
      const isFrontpage = url.includes(
        encodeURIComponent('"player_type":"frontpage"')
      );
      const channelName = findChannelFromUsherUrl(url);
      const isWhitelisted = isChannelWhitelisted(channelName, pageState);
      if (!isLivestream || isFrontpage || isWhitelisted) {
        logger.log(
          "Not flagging Usher request: not a livestream, is frontpage, or is whitelisted."
        );
        break usherReq;
      }

      // Inspect the initial stream directly. Escalate to the proxy replacement
      // path only after the Video Weaver response confirms an ad.
      const shouldUseFastStart =
        pageState.state?.userExperienceMode === "blockAds" &&
        pageState.state.optimizedProxiesEnabled === true;
      const shouldFlagRequest =
        !shouldUseFastStart &&
        isRequestTypeProxied(ProxyRequestType.Usher, {
          isChromium: pageState.isChromium,
          optimizedProxiesEnabled:
            pageState.state?.optimizedProxiesEnabled ?? true,
          passportLevel: pageState.state?.passportLevel ?? 0,
          customPassport: pageState.state?.customPassportEnabled
            ? pageState.state.customPassport
            : null,
        });
      const shouldOverrideRequest = pageState.state?.anonymousMode === true;
      if (shouldOverrideRequest) {
        logger.log("Overriding Usher request…");
        request = new Request(anonymizeUsherUrl(url), {
          ...init,
        });
      }
      if (shouldFlagRequest) {
        logger.log("Flagging Usher request…");
        isFlaggedRequest = true;
      }
    }

    // Twitch Video Weaver requests.
    weaverReq: if (host != null && videoWeaverHostRegex.test(host)) {
      requestType = ProxyRequestType.VideoWeaver;

      const manifest = usherManifests.find(manifest =>
        [...manifest.assignedMap.values()].includes(url)
      );
      if (manifest == null) {
        logger.warn(
          "No associated Usher manifest found for Video Weaver request."
        );
      }
      if (videoWeaverUrlsToNotProxy.has(url)) {
        logger.debugOnce(
          `${url}_not_proxied`,
          `Not flagging request to Video Weaver URL '${url}': is frontpage or is whitelisted.`
        );
        break weaverReq;
      }

      // Check if we should replace the Video Weaver URL.
      let videoWeaverUrl = url;
      if (manifest?.replacementMap != null) {
        const videoQuality = [...manifest.assignedMap].find(
          ([, url]) => url === videoWeaverUrl
        )?.[0];
        if (videoQuality != null && manifest.replacementMap.has(videoQuality)) {
          videoWeaverUrl = manifest.replacementMap.get(videoQuality)!;
          logger.debugOnce(
            `${videoWeaverUrl}_replacement`,
            `Replaced Video Weaver URL '${url}' with '${videoWeaverUrl}'.`
          );
        } else if (manifest.replacementMap.size > 0) {
          videoWeaverUrl = [...manifest.replacementMap.values()][0];
          logger.warn(
            `Replacement Video Weaver URL not found for '${url}'. Using first replacement URL '${videoWeaverUrl}'.`
          );
        } else {
          logger.error(`Replacement Video Weaver URL not found for '${url}'.`);
        }
      }
      if (videoWeaverUrl !== url) {
        request ??= new Request(videoWeaverUrl, {
          ...init,
        });
        if (videoWeaverUrlsToNotProxy.has(videoWeaverUrl)) {
          logger.debugOnce(
            `${videoWeaverUrl}_replacement_not_proxied`,
            `Not flagging request to replacement Video Weaver URL '${videoWeaverUrl}': is non-proxied stream.`
          );
          break weaverReq;
        }
      }

      // Flag first request to each Video Weaver URL.
      await waitForStore(pageState);
      const isReplacementRequest = videoWeaverUrl !== url;
      const shouldUseFastStart =
        pageState.state?.userExperienceMode === "blockAds" &&
        pageState.state.optimizedProxiesEnabled === true &&
        !isReplacementRequest;
      const shouldFlagRequest =
        !shouldUseFastStart &&
        isRequestTypeProxied(ProxyRequestType.VideoWeaver, {
          isChromium: pageState.isChromium,
          optimizedProxiesEnabled:
            pageState.state?.optimizedProxiesEnabled ?? true,
          passportLevel: pageState.state?.passportLevel ?? 0,
          customPassport: pageState.state?.customPassportEnabled
            ? pageState.state.customPassport
            : null,
        });
      const proxiedCount = videoWeaverUrlsProxiedCount.get(videoWeaverUrl) ?? 0;
      if (shouldFlagRequest && proxiedCount < 1) {
        videoWeaverUrlsProxiedCount.set(videoWeaverUrl, proxiedCount + 1);
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules/PluralRules#using_options
        const pr = new Intl.PluralRules("en-US", { type: "ordinal" });
        const suffixes = new Map([
          ["one", "st"],
          ["two", "nd"],
          ["few", "rd"],
          ["other", "th"],
        ]);
        const formatOrdinals = (n: number) => {
          const rule = pr.select(n);
          const suffix = suffixes.get(rule);
          return `${n}${suffix}`;
        };
        logger.log(
          `Flagging ${formatOrdinals(
            proxiedCount + 1
          )} request to Video Weaver URL '${videoWeaverUrl}'…`
        );
        isFlaggedRequest = true;
      }
    }

    //#endregion

    request ??= new Request(input, {
      ...init,
      headers: Object.fromEntries(headersMap),
    });
    let response: Response;
    let splitResponse: Response | null = null;
    if (isFlaggedRequest) {
      await waitForStore(pageState);
      [response, splitResponse] = await Promise.all([
        flagRequestAndFetch(request, requestType!, pageState),
        ...(splitRequest ? [NATIVE_FETCH(splitRequest)] : []), // Split requests are never proxied.
      ]);
    } else {
      if (pageState.isChromium && requestType !== null) {
        await waitForStore(pageState);
        if (pageState.state?.optimizedProxiesEnabled ?? true) {
          // Wait for proxied requests of the same type to finish.
          const mutex = pageState.requestTypeMutexes[requestType];
          const isLocked = mutex.isLocked();
          if (isLocked) {
            logger.debug(`🔒 Waiting for '${requestType}'… (${url})`);
          }
          await mutex.waitForUnlock();
          if (isLocked) {
            logger.debug(`🔓 Done waiting for '${requestType}' (${url})`);
          }
        }
      }
      [response, splitResponse] = await Promise.all([
        NATIVE_FETCH(request),
        ...(splitRequest ? [NATIVE_FETCH(splitRequest)] : []),
      ]);
    }

    // Reading the response body can be expensive, so we only do it if we need to.
    let responseBody: string | undefined = undefined;
    const readResponseBody = async (): Promise<string> => {
      if (responseBody !== undefined) return responseBody;
      const clonedResponse = response.clone();
      return clonedResponse.text();
    };

    // Merge split responses.
    if (splitResponse != null && splitIndexMap != null) {
      try {
        responseBody ??= await readResponseBody();
        const responseBodyParsed = JSON.parse(responseBody);
        const splitResponseBody = await splitResponse.text();
        const splitResponseBodyParsed = JSON.parse(splitResponseBody);
        const mergedBodyMap = new Map<number, any>(); // originalIndex -> value
        if (Array.isArray(responseBodyParsed)) {
          for (const [index, originalIndex] of splitIndexMap[0].entries()) {
            mergedBodyMap.set(originalIndex, responseBodyParsed[index]);
          }
        }
        if (Array.isArray(splitResponseBodyParsed)) {
          for (const [index, originalIndex] of splitIndexMap[1].entries()) {
            mergedBodyMap.set(originalIndex, splitResponseBodyParsed[index]);
          }
        }
        if (mergedBodyMap.size === 0) {
          logger.error("No entries found to merge from split responses:", {
            responseBodyParsed,
            splitResponseBodyParsed,
          });
          throw new Error("No entries to merge.");
        }
        const mergedBody = [...mergedBodyMap.entries()]
          .sort(([a, _], [b, __]) => a - b)
          .map(([_, value]) => value);
        const mergedBodyStringified = JSON.stringify(mergedBody);
        response = new Response(mergedBodyStringified, {
          ...response,
        });
        responseBody = mergedBodyStringified;
        logger.debug("Successfully merged split responses.", mergedBody);
      } catch (error) {
        logger.error("Failed to merge split responses:", error);
      }
    }

    //#region Responses

    // Twitch Usher responses.
    usherRes: if (
      host != null &&
      usherHostRegex.test(host) &&
      response.status < 400
    ) {
      await waitForStore(pageState);
      const isLivestream = !url.includes("/vod/");
      const isFrontpage = url.includes(
        encodeURIComponent('"player_type":"frontpage"')
      );
      const channelName = findChannelFromUsherUrl(url);
      const isWhitelisted = isChannelWhitelisted(channelName, pageState);
      if (!isLivestream) break usherRes;

      responseBody ??= await readResponseBody();
      usherManifests = usherManifests.filter(manifest => !manifest.deleted); // Clean up deleted manifests.
      const assignedMap = parseUsherManifest(responseBody);
      if (assignedMap != null) {
        logger.debug(
          "Received Usher response:",
          Object.fromEntries(assignedMap)
        );
        usherManifests.push({
          channelName,
          assignedMap: assignedMap,
          replacementMap: null,
          deleted: false,
        });
      } else {
        logger.error("Received Usher response but failed to parse it.");
      }
      // Send Video Weaver URLs to content script.
      const videoWeaverUrls = [...(assignedMap?.values() ?? [])];
      videoWeaverUrls.forEach(url => {
        videoWeaverUrlsProxiedCount.delete(url); // Shouldn't be necessary, but just in case.
        videoWeaverUrlsToNotProxy.delete(url); // Shouldn't be necessary, but just in case.
        if (isFrontpage || isWhitelisted) videoWeaverUrlsToNotProxy.add(url);
      });
      const proxyCountryRegex = url.toLowerCase().includes("/api/v2/")
        ? /"USER-COUNTRY",VALUE="([A-Z]+)"/i
        : /USER-COUNTRY="([A-Z]+)"/i;
      pageState.sendMessageToContentScript({
        type: MessageType.UsherResponse,
        channel: channelName,
        videoWeaverUrls,
        proxyCountry: proxyCountryRegex.exec(responseBody)?.[1] || undefined,
      });
    }

    // Twitch Video Weaver responses.
    weaverRes: if (
      host != null &&
      videoWeaverHostRegex.test(host) &&
      response.status < 400
    ) {
      const manifest = usherManifests.find(manifest =>
        [...manifest.assignedMap.values()].includes(url)
      );
      if (manifest == null) {
        logger.error(
          "No associated Usher manifest found for Video Weaver response."
        );
        break weaverRes;
      }

      // Check if response contains an ad.
      responseBody ??= await readResponseBody();
      const videoWeaverResponseBody = responseBody;
      const responseBodyLower = videoWeaverResponseBody.toLowerCase();
      const responseIncludesAd = responseBodyLower.includes("stitched-ad");
      if (responseIncludesAd) logger.log("Ad detected.");
      await waitForStore(pageState);

      const updateAdLogForDetectedResponse = () => {
        if (
          !responseIncludesAd ||
          pageState.state?.adLogEnabled !== true ||
          videoWeaverUrlsToNotProxy.has(url)
        ) {
          return;
        }
        const lines = videoWeaverResponseBody.split("\n");
        const adLines = lines.filter(line => {
          const lineLower = line.toLowerCase();
          return lineLower.includes("preroll") || lineLower.includes("midroll");
        });
        for (const adLine of adLines) {
          const parser = new m3u8Parser.Parser();
          parser.push(adLine);
          parser.end();
          const dateRange = parser.manifest.dateRanges?.[0];
          const parsedLine = dateRange
            ? {
                adRollType: dateRange.xTvTwitchAdRollType,
                adUrl: dateRange.xTvTwitchAdUrl,
                adUrlHighlight: getHighlightOfAdUrl(
                  dateRange.xTvTwitchAdUrl as string | undefined
                ),
                adClickTrackingUrl: dateRange.xTvTwitchAdClickTrackingUrl,
                adClickTrackingUrlHighlight: getHighlightOfAdUrl(
                  dateRange.xTvTwitchAdClickTrackingUrl as string | undefined
                ),
                adLineItemId: dateRange.xTvTwitchAdLineItemId,
                adCommercialId: dateRange.xTvTwitchAdCommercialId,
                adDsaAdvertiserId: dateRange.xTvTwitchAdDsaAdvertiserId,
                adDsaCampaignId: dateRange.xTvTwitchAdDsaCampaignId,
              }
            : undefined;
          pageState.sendMessageToContentScript({
            type: MessageType.UpdateAdLog,
            timestamp: Date.now(),
            channelName: manifest.channelName,
            videoWeaverUrl: url,
            rawLine: adLine,
            parsedLine,
          });
        }
      };

      //#region Ad replacement.
      if (
        pageState.state?.userExperienceMode !== "unlockBestQuality" &&
        pageState.state?.optimizedProxiesEnabled === true &&
        !videoWeaverUrlsToNotProxy.has(url) // `url` (assigned) != `videoWeaverUrl` (replacement).
      ) {
        if (responseIncludesAd) {
          const replacementKey =
            manifest.channelName ?? getHostFromUrl(url) ?? "unknown";
          await handleDetectedAd({
            coordinator: adReplacementCoordinator,
            key: replacementKey,
            replace: () =>
              updateVideoWeaverReplacementMap(
                pageState,
                cachedUsherRequestUrl,
                // Not using `!isFlaggedRequest` to avoid overriding user
                // passport settings. Temporarily disabling proxying is fine
                // though.
                isFlaggedRequest ? false : undefined
              ),
            onReplacement: replacement => {
              const relatedManifests = manifest.channelName
                ? usherManifests.filter(
                    candidate =>
                      candidate.channelName?.toLowerCase() ===
                      manifest.channelName?.toLowerCase()
                  )
                : [manifest];
              relatedManifests.forEach(candidate => {
                candidate.replacementMap = replacement.replacementMap;
              });

              if (isFlaggedRequest) {
                // Current request has already been proxied, so we don't proxy
                // the replacement URLs in the hope that they might not
                // contain ads since the new Usher's "USER-IP" is different.
                replacement.videoWeaverUrls.forEach(url =>
                  videoWeaverUrlsToNotProxy.add(url)
                );
                logger.debug(
                  "Added replacement Video Weaver URLs to non-proxy list:",
                  replacement.videoWeaverUrls
                );
              }
            },
            onFailure: error => {
              logger.error(error);
              pageState.sendMessageToContentScript({
                type: MessageType.ExtensionError,
                errorMessage: `Failed to replace ad: ${getErrorMessage(error)}`,
              });
              updateAdLogForDetectedResponse();
            },
            cancelRequest,
          });
        }
      }
      //#endregion

      //#region Ad log.
      updateAdLogForDetectedResponse();
      //#endregion
    }

    //#endregion

    return response;
  };
}

/**
 * Converts a HeadersInit to a map.
 * @param input
 * @param init
 * @returns
 */
function getHeadersMap(
  input: RequestInfo | URL,
  init?: RequestInit
): Map<string, string> {
  const headers = input instanceof Request ? input.headers : init?.headers;
  if (!headers) return new Map();
  if (headers instanceof Headers) {
    return new Map(headers.entries());
  }
  if (Array.isArray(headers)) {
    return new Map(headers);
  }
  return new Map(Object.entries(headers));
}

/**
 * Converts a BodyInit to a string.
 * @param input
 * @param init
 * @returns
 */
async function getRequestBodyText(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string | null> {
  if (input instanceof Request) {
    const clonedRequest = input.clone();
    return clonedRequest.text();
  }
  const body = init?.body;
  if (body == null) return null;
  if (body instanceof Blob) {
    return body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof FormData) {
    const entries = [...body.entries()];
    return entries.map(e => `${e[0]}=${e[1]}`).join("&");
  }
  return body.toString();
}

function findHeaderFromMap(
  headersMap: Map<string, string>,
  name: string
): string | undefined {
  return [...headersMap.keys()].find(
    header => header.toLowerCase() === name.toLowerCase()
  );
}

function getHeaderFromMap(
  headersMap: Map<string, string>,
  name: string
): string | null {
  const header = findHeaderFromMap(headersMap, name);
  return header != null ? headersMap.get(header)! : null;
}

function setHeaderToMap(
  headersMap: Map<string, string>,
  name: string,
  value: string
) {
  const header = findHeaderFromMap(headersMap, name);
  headersMap.set(header ?? name, value);
}

function removeHeaderFromMap(headersMap: Map<string, string>, name: string) {
  const header = findHeaderFromMap(headersMap, name);
  if (header != null) {
    headersMap.delete(header);
  }
}

async function waitForStore(pageState: PageState) {
  if (pageState.state != null) return;
  try {
    const message =
      await pageState.sendMessageToContentScriptAndWaitForResponse(
        pageState.scope,
        {
          type: MessageType.GetStoreState,
          from: pageState.scope,
        },
        MessageType.GetStoreStateResponse
      );
    pageState.state = message.state;
  } catch (error) {
    logger.error("Failed to get store state:", error);
  }
}

function isChannelWhitelisted(
  channelName: string | null | undefined,
  pageState: PageState
): boolean {
  if (!channelName) return false;
  const channelNameLower = channelName.toLowerCase();
  return (
    pageState.state?.whitelistedChannels.some(
      channel => channel.toLowerCase() === channelNameLower
    ) ?? false
  );
}

/**
 * Partitions an array or map into two maps based on a predicate.
 * The keys of the returned maps correspond to the original indices or keys.
 * @param items
 * @param predicate
 * @returns A tuple of two maps: [truthyMap, falsyMap]
 */
function partitionMap<T>(
  items: T[] | Map<number, T>,
  predicate: (item: T) => boolean
): [Map<number, T>, Map<number, T>] {
  const truthyMap = new Map<number, T>();
  const falsyMap = new Map<number, T>();
  if (items instanceof Map) {
    for (const [key, value] of items.entries()) {
      (predicate(value) ? truthyMap : falsyMap).set(key, value);
    }
  } else {
    for (let i = 0; i < items.length; i++) {
      (predicate(items[i]) ? truthyMap : falsyMap).set(i, items[i]);
    }
  }
  return [truthyMap, falsyMap];
}

function anonymizeUsherUrl(usherUrl: string): string {
  try {
    const url = new URL(usherUrl);
    url.searchParams.set("p", Math.floor(Math.random() * 10000000).toString());
    url.searchParams.set(
      "play_session_id",
      generateRandomString(32, Charset.ALPHANUMERIC_LOWERCASE)
    );
    return url.toString();
  } catch {
    return usherUrl;
  }
}

async function _flagRequest(
  request: Request,
  requestType: ProxyRequestType,
  pageState: PageState
): Promise<{ request: Request; fullModeRequestId?: string }> {
  if (pageState.isChromium) {
    if (!pageState.state?.optimizedProxiesEnabled) return { request };
    try {
      const response =
        await pageState.sendMessageToContentScriptAndWaitForResponse(
          pageState.scope,
          {
            type: MessageType.EnableFullMode,
            timestamp: Date.now(),
            requestType,
          },
          MessageType.EnableFullModeResponse
        );
      return { request, fullModeRequestId: response.requestId };
    } catch (error) {
      logger.error(`Failed to flag '${requestType}' request:`, error);
      pageState.sendMessageToContentScript({
        type: MessageType.ExtensionError,
        errorMessage: `Failed to flag '${requestType}' request: ${error}`,
      });
    }
    return { request };
  } else {
    // Change the Accept header to include the flag.
    const headersMap = getHeadersMap(request);
    const accept = getHeaderFromMap(headersMap, "Accept");
    if (accept != null && accept.includes(acceptFlag)) return { request };
    setHeaderToMap(headersMap, "Accept", `${accept || ""}${acceptFlag}`);
    return {
      request: new Request(request, {
        headers: Object.fromEntries(headersMap),
      }),
    };
  }
}

async function _flagRequestCleanup(
  requestType: ProxyRequestType,
  pageState: PageState,
  fullModeRequestId?: string
) {
  if (!pageState.isChromium) return;
  if (!pageState.state?.optimizedProxiesEnabled) return;
  try {
    await pageState.sendMessageToContentScriptAndWaitForResponse(
      pageState.scope,
      {
        type: MessageType.DisableFullMode,
        timestamp: Date.now(),
        requestType,
        fullModeRequestId,
      },
      MessageType.DisableFullModeResponse
    );
  } catch (error) {
    logger.error(`Failed to cleanup flagged '${requestType}' request:`, error);
  }
}

async function flagRequestAndFetch(
  request: Request,
  requestType: ProxyRequestType,
  pageState: PageState
): Promise<Response> {
  const doWork = async () => {
    const { request: flaggedRequest, fullModeRequestId } = await _flagRequest(
      request,
      requestType,
      pageState
    );
    try {
      return await NATIVE_FETCH(flaggedRequest);
    } finally {
      await _flagRequestCleanup(requestType, pageState, fullModeRequestId);
    }
  };
  if (pageState.isChromium && pageState.state?.optimizedProxiesEnabled) {
    const mutex = pageState.requestTypeMutexes[requestType];
    const isLocked = mutex.isLocked();
    if (isLocked) {
      logger.debug(`🔒 Waiting for '${requestType}'… (${request.url})`);
    }
    let response: Response;
    await mutex.runExclusive(async () => {
      if (isLocked) {
        logger.debug(`🔓 Done waiting for '${requestType}' (${request.url})`);
      }
      logger.debug(`🔒 Locked '${requestType}' (${request.url})`);
      response = await doWork();
      logger.debug(`🔓 Unlocked '${requestType}' (${request.url})`);
    });
    return response!;
  } else {
    return await doWork();
  }
}

function cancelRequest(): never {
  logger.debug("Cancelled request.");
  throw new Error();
}

/**
 * Get the highlight of a raw manifest ad URL.
 * @param url
 * @returns
 */
function getHighlightOfAdUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const parts = url.split("|").map(p => p.trim());
  if (parts.length === 0) return "";
  // Find a nested http(s) occurrence (case-insensitive).
  const schemeRegex = /https?:\/\//gi;
  let chosen: string | null = null;
  for (const part of parts) {
    const matches = [...part.matchAll(schemeRegex)];
    if (matches.length >= 2) {
      chosen = part.slice(matches[1].index!).trim();
      break;
    }
  }
  // Fallback: Shortest non-empty part.
  if (!chosen) {
    chosen = parts.reduce((a, b) => (a.length <= b.length ? a : b));
  }
  // Remove scheme for brevity.
  chosen = chosen.replace(/^https?:\/\//i, "");
  // Truncate if too long.
  const maxLength = 50;
  if (chosen.length <= maxLength) return chosen;
  return `${chosen.slice(0, maxLength - 1)}…`;
}

//#region Video Weaver URL replacement

function getDefaultPlaybackAccessTokenQueryAndHeaders(
  channel: string,
  anonymousMode: boolean,
  playerType?: string
): { query: any; headersMap: Map<string, string> } {
  const isVod = /^\d+$/.test(channel); // VODs have numeric IDs.
  const cookieMap = new Map<string, string>(
    document.cookie
      .split(";")
      .map(cookie => cookie.trim().split("="))
      .map(([name, value]) => [name, decodeURIComponent(value)])
  );
  return {
    query: {
      operationName: "PlaybackAccessToken_Template",
      query:
        'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}',
      variables: {
        isLive: !isVod,
        isVod: isVod,
        login: isVod ? "" : channel,
        platform: "web",
        playerType: playerType ?? "site",
        vodID: isVod ? channel : "",
      },
    },
    headersMap: new Map<string, string>([
      [
        "Authorization",
        cookieMap.has("auth-token") && !anonymousMode
          ? `OAuth ${cookieMap.get("auth-token")}`
          : "undefined",
      ],
      ["Client-ID", "kimne78kx3ncx6brgo4mv6wki5h1ko"],
      ["Content-Type", "text/plain; charset=UTF-8"],
      ["Device-ID", generateRandomString(32)],
    ]),
  };
}

/**
 * Returns a PlaybackAccessToken request that can be used when Twitch doesn't send one.
 * @param channel
 * @param anonymousMode
 * @returns
 */
function getDefaultPlaybackAccessTokenRequest(
  channel: string | null = null,
  anonymousMode: boolean = false
): Request | null {
  // We can use `location.href` because we're in the page script.
  const channelName = channel ?? findChannelFromTwitchTvUrl(location.href);
  if (!channelName) return null;
  const { query, headersMap } = getDefaultPlaybackAccessTokenQueryAndHeaders(
    channelName,
    anonymousMode
  );
  return new Request("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: Object.fromEntries(headersMap),
    body: JSON.stringify(query),
  });
}

/**
 * Fetches a new PlaybackAccessToken from Twitch.
 * @param pageState
 * @param cachedPlaybackTokenRequestHeaders
 * @param cachedPlaybackTokenRequestBody
 * @param isFlaggedRequestOverride
 * @returns
 */
async function fetchReplacementPlaybackAccessToken(
  pageState: PageState,
  cachedPlaybackTokenRequestHeaders: Map<string, string> | null,
  cachedPlaybackTokenRequestBody: string | null,
  isFlaggedRequestOverride?: boolean
): Promise<PlaybackAccessToken | null> {
  // Not using the cached request because we'd need to check if integrity requests are proxied.
  try {
    let request = getDefaultPlaybackAccessTokenRequest(
      null,
      pageState.state?.anonymousMode === true
    );
    if (request == null) return null;
    const isFlaggedRequest =
      isFlaggedRequestOverride ??
      isRequestTypeProxied(ProxyRequestType.GraphQLToken, {
        isChromium: pageState.isChromium,
        optimizedProxiesEnabled:
          pageState.state?.optimizedProxiesEnabled ?? true,
        passportLevel: pageState.state?.passportLevel ?? 0,
        customPassport: pageState.state?.customPassportEnabled
          ? pageState.state.customPassport
          : null,
      });
    const response = isFlaggedRequest
      ? await flagRequestAndFetch(request, ProxyRequestType.GraphQL, pageState)
      : await NATIVE_FETCH(request);
    const json = await response.json();
    const newPlaybackAccessToken = json?.data?.streamPlaybackAccessToken;
    if (newPlaybackAccessToken == null) return null;
    return newPlaybackAccessToken;
  } catch {
    return null;
  }
}

/**
 * Returns a new Usher URL with the new playback access token.
 * @param cachedUsherRequestUrl
 * @param playbackAccessToken
 * @returns
 */
function getReplacementUsherUrl(
  cachedUsherRequestUrl: string | null,
  playbackAccessToken: PlaybackAccessToken
): string | null {
  if (cachedUsherRequestUrl == null) return null; // Very unlikely.
  try {
    const newUsherUrl = new URL(cachedUsherRequestUrl);
    newUsherUrl.searchParams.set("sig", playbackAccessToken.signature);
    newUsherUrl.searchParams.set("token", playbackAccessToken.value);
    return anonymizeUsherUrl(newUsherUrl.toString()); // Always anonymize, regardless of anonymous mode.
  } catch {
    return null;
  }
}

/**
 * Fetches a new Usher manifest from Twitch.
 * @param pageState
 * @param cachedUsherRequestUrl
 * @param playbackAccessToken
 * @param isFlaggedRequestOverride
 * @returns
 */
async function fetchReplacementUsherManifest(
  pageState: PageState,
  cachedUsherRequestUrl: string | null,
  playbackAccessToken: PlaybackAccessToken,
  isFlaggedRequestOverride?: boolean
): Promise<string> {
  if (cachedUsherRequestUrl == null) {
    throw new Error("No cached Usher request is available.");
  }
  const newUsherUrl = getReplacementUsherUrl(
    cachedUsherRequestUrl,
    playbackAccessToken
  );
  if (newUsherUrl == null) {
    throw new Error("Failed to construct the replacement Usher request.");
  }
  const request = new Request(newUsherUrl);
  const isFlaggedRequest =
    isFlaggedRequestOverride ??
    isRequestTypeProxied(ProxyRequestType.Usher, {
      isChromium: pageState.isChromium,
      optimizedProxiesEnabled: pageState.state?.optimizedProxiesEnabled ?? true,
      passportLevel: pageState.state?.passportLevel ?? 0,
      customPassport: pageState.state?.customPassportEnabled
        ? pageState.state.customPassport
        : null,
    });
  const response = isFlaggedRequest
    ? await flagRequestAndFetch(request, ProxyRequestType.Usher, pageState)
    : await NATIVE_FETCH(request);
  if (response.status >= 400) {
    throw new Error(
      `Replacement Usher request returned HTTP ${response.status}.`
    );
  }
  return response.text();
}

/**
 * Parses a Usher response and returns a map of video quality to Video Weaver URL.
 * @param manifest
 * @returns
 */
function parseUsherManifest(manifest: string): Map<string, string> | null {
  const parser = new m3u8Parser.Parser();
  parser.push(manifest);
  parser.end();
  const playlists = parser.manifest.playlists;
  if (!playlists || playlists.length === 0) {
    return null;
  }

  type ParsedAttributes = {
    resolution?: { width: number; height: number };
    frameRate?: number;
    score?: number;
  };
  const getParsedAttributes = (
    playlist: (typeof playlists)[number]
  ): ParsedAttributes => {
    return {
      resolution: playlist.attributes["RESOLUTION"],
      frameRate: playlist.attributes["FRAME-RATE"],
      score: playlist.attributes["SCORE"],
    } as ParsedAttributes;
  };

  const keyCount = new Map<string, number>();
  const parsedManifest = new Map<string, string>();

  const playlistAttributes = playlists.map(playlist => ({
    playlist,
    attributes: getParsedAttributes(playlist),
  }));
  playlistAttributes.sort((a, b) => {
    if (a.attributes.score && b.attributes.score) {
      return b.attributes.score - a.attributes.score;
    }
    return b.playlist.uri.length - a.playlist.uri.length;
  });
  playlistAttributes.forEach(({ playlist, attributes }, index) => {
    const key = attributes.resolution?.height
      ? `${attributes.resolution.height}p${
          attributes.frameRate ? Math.round(attributes.frameRate) : ""
        }`
      : `idx_${index}`;
    const count = keyCount.get(key) ?? 0;
    keyCount.set(key, count + 1);
    parsedManifest.set(count === 0 ? key : `${key}_${count}`, playlist.uri);
  });

  return parsedManifest;
}

/**
 * Updates the replacement Video Weaver URLs.
 * @param pageState
 * @param cachedUsherRequestUrl
 * @param isFlaggedRequestOverride
 * @returns
 */
async function updateVideoWeaverReplacementMap(
  pageState: PageState,
  cachedUsherRequestUrl: string | null,
  isFlaggedRequestOverride?: boolean
): Promise<VideoWeaverReplacement> {
  logger.log("Getting replacement Video Weaver URLs…");
  try {
    logger.log("(1/3) Getting new PlaybackAccessToken…");
    const newPlaybackAccessTokenResponse =
      await pageState.sendMessageToPageScriptAndWaitForResponse(
        "worker",
        {
          type: MessageType.NewPlaybackAccessToken,
          isFlaggedRequestOverride,
        },
        MessageType.NewPlaybackAccessTokenResponse
      );
    const newPlaybackAccessToken: PlaybackAccessToken | undefined =
      newPlaybackAccessTokenResponse?.newPlaybackAccessToken;
    if (newPlaybackAccessToken == null) {
      throw new Error("Failed to get new PlaybackAccessToken.");
    }

    logger.log("(2/3) Fetching new Usher manifest…");
    const newUsherManifest = await fetchReplacementUsherManifest(
      pageState,
      cachedUsherRequestUrl,
      newPlaybackAccessToken,
      isFlaggedRequestOverride
    );

    logger.log("(3/3) Parsing new Usher manifest…");
    const replacementMap = parseUsherManifest(newUsherManifest);
    if (replacementMap == null || replacementMap.size === 0) {
      throw new Error("Failed to parse new Usher manifest.");
    }

    logger.log(
      "Replacement Video Weaver URLs:",
      Object.fromEntries(replacementMap)
    );

    // Send replacement Video Weaver URLs to content script.
    const videoWeaverUrls = [...replacementMap.values()];
    if (cachedUsherRequestUrl != null && videoWeaverUrls.length > 0) {
      const proxyCountryRegex = cachedUsherRequestUrl
        .toLowerCase()
        .includes("/api/v2/")
        ? /"USER-COUNTRY",VALUE="([A-Z]+)"/i
        : /USER-COUNTRY="([A-Z]+)"/i;
      pageState.sendMessageToContentScript({
        type: MessageType.UsherResponse,
        channel: findChannelFromUsherUrl(cachedUsherRequestUrl),
        videoWeaverUrls,
        proxyCountry:
          proxyCountryRegex.exec(newUsherManifest)?.[1] || undefined,
      });
    }

    return { replacementMap, videoWeaverUrls };
  } catch (error) {
    throw new Error(
      `Failed to get replacement Video Weaver URLs: ${getErrorMessage(error)}`
    );
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}

//#endregion
