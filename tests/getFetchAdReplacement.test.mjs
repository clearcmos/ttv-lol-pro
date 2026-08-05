import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[^/]+$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    };
  },
});

const assignedPlaylistUrl =
  "https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/assigned.m3u8";
const replacementPlaylistUrl =
  "https://video-weaver.fra02.hls.ttvnw.net/v1/playlist/replacement.m3u8";
const assignedUsherManifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60
${assignedPlaylistUrl}
`;
const replacementUsherManifest = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60
${replacementPlaylistUrl}
`;
const adPlaylist = `#EXTM3U
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad"
#EXTINF:2.0,live
https://example.invalid/ad-segment.ts
`;
const cleanPlaylist = `#EXTM3U
#EXTINF:2.0,live
https://example.invalid/live-segment.ts
`;

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
  }

  addEventListener() {}
  postMessage() {}
}

const fetchCalls = [];
const nativeFetch = async input => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  fetchCalls.push(url.toString());

  if (url.hostname === "usher.ttvnw.net") {
    return new Response(
      url.searchParams.get("sig") === "replacement-signature"
        ? replacementUsherManifest
        : assignedUsherManifest,
      { status: 200 }
    );
  }
  if (url.toString() === assignedPlaylistUrl) {
    return new Response(adPlaylist, { status: 200 });
  }
  if (url.toString() === replacementPlaylistUrl) {
    return new Response(cleanPlaylist, { status: 200 });
  }
  throw new Error(`Unexpected fetch: ${url.origin}${url.pathname}`);
};

globalThis.self = globalThis;
globalThis.self.fetch = nativeFetch;
globalThis.BroadcastChannel = FakeBroadcastChannel;

const { default: getFetch } = await import("../src/page/getFetch.ts");

function createMutex() {
  return {
    isLocked: () => false,
    waitForUnlock: async () => {},
    runExclusive: async callback => callback(),
  };
}

function createPageState(stateOverrides = {}, proxyMessages = []) {
  const mutex = createMutex();
  return {
    params: { broadcastChannelName: "get-fetch-ad-replacement-test" },
    isChromium: true,
    scope: "worker",
    state: {
      adLogEnabled: false,
      anonymousMode: false,
      customPassportEnabled: false,
      optimizedProxiesEnabled: true,
      passportLevel: 0,
      userExperienceMode: "blockAds",
      whitelistedChannels: [],
      ...stateOverrides,
    },
    requestTypeMutexes: new Proxy({}, { get: () => mutex }),
    twitchWorkers: [],
    sendMessageToContentScript: () => {},
    sendMessageToContentScriptAndWaitForResponse: async (_, message) => {
      proxyMessages.push(message);
      return { requestId: "proxy-request" };
    },
    sendMessageToPageScript: () => {},
    sendMessageToPageScriptAndWaitForResponse: async () => ({
      newPlaybackAccessToken: {
        value: "replacement-token",
        signature: "replacement-signature",
      },
    }),
    sendMessageToWorkerScripts: () => {},
    sendMessageToWorkerScriptsAndWaitForResponse: async () => ({}),
  };
}

test("returns a clean replacement playlist without waiting for a player retry", async () => {
  fetchCalls.length = 0;
  const wrappedFetch = getFetch(createPageState());
  const usherUrl =
    "https://usher.ttvnw.net/api/channel/hls/testchannel.m3u8?sig=assigned-signature&token=assigned-token";

  await wrappedFetch(usherUrl);
  const response = await wrappedFetch(assignedPlaylistUrl);

  assert.equal(await response.text(), cleanPlaylist);
  assert.equal(fetchCalls.filter(url => url === assignedPlaylistUrl).length, 1);
  assert.equal(
    fetchCalls.filter(url => url === replacementPlaylistUrl).length,
    1
  );
});

test("respects an expert-mode setting that disables Video Weaver proxying", async () => {
  fetchCalls.length = 0;
  const proxyMessages = [];
  const wrappedFetch = getFetch(
    createPageState(
      {
        customPassportEnabled: true,
        customPassport: {
          passport: false,
          usher: false,
          videoWeaver: false,
          graphQLToken: false,
          graphQLIntegrity: false,
          graphQLAll: false,
          twitchWebpage: false,
        },
        userExperienceMode: "expertMode",
      },
      proxyMessages
    )
  );
  const usherUrl =
    "https://usher.ttvnw.net/api/channel/hls/testchannel.m3u8?sig=assigned-signature&token=assigned-token";

  await wrappedFetch(usherUrl);
  const response = await wrappedFetch(assignedPlaylistUrl);

  assert.equal(await response.text(), cleanPlaylist);
  assert.equal(proxyMessages.length, 0);
});
