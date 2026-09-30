import { deployFolder } from "../deploy/deploy-folder.js";

export const DEPLOY_HEADER = "X-Bunny-Deploy";
// The action finds its own rules again by this prefix, so descriptions must not change.
export const RULE_PREFIX = "bunny-edge-deploy: ";

const ACTION = { blockRequest: 4, setResponseHeader: 5, overrideBrowserCacheTime: 16, originStorage: 17 };
const TRIGGER = { url: 0, urlExtension: 3 };
const MATCH = { any: 0, none: 2 };
// Bunny accepts at most five patterns per trigger.
const ASSET_EXTENSION_GROUPS = [["css", "js", "mjs", "woff2", "svg"], ["png", "jpg", "jpeg", "webp", "ico"], ["wasm", "onnx", "woff", "ttf", "otf"]];

const rule = (description, fields) => ({ Description: `${RULE_PREFIX}${description}`, Enabled: true, ...fields });

export function siteRules({ storageZone, deployId }) {
  return [
    rule("serve the published deploy", {
      ActionType: ACTION.originStorage,
      ActionParameter1: String(storageZone.Id),
      ActionParameter2: storageZone.Name,
      ActionParameter3: `/${deployFolder(deployId)}/`,
      ExtraActions: [{ ActionType: ACTION.setResponseHeader, ActionParameter1: DEPLOY_HEADER, ActionParameter2: deployId }],
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.url, PatternMatches: ["*/deploys/*"], PatternMatchingType: MATCH.none }],
    }),
    rule("block deploy folders", {
      ActionType: ACTION.blockRequest,
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.url, PatternMatches: ["*/deploys/*"], PatternMatchingType: MATCH.any }],
    }),
    rule("block host config files", {
      ActionType: ACTION.blockRequest,
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.url, PatternMatches: ["*/_headers", "*/_redirects"], PatternMatchingType: MATCH.any }],
    }),
    ...ASSET_EXTENSION_GROUPS.map((extensions, index) => rule(`browser-cache static assets (${index + 1})`, {
      ActionType: ACTION.overrideBrowserCacheTime,
      ActionParameter1: "86400",
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.urlExtension, PatternMatches: extensions, PatternMatchingType: MATCH.any }],
    })),
  ];
}

// The 404 path is a storage zone setting, so it moves with every publish; the API only clears it with an empty path.
export function notFoundSettings({ deployId, files }) {
  return { Custom404FilePath: files.includes("404.html") ? `/${deployFolder(deployId)}/404.html` : "", Rewrite404To200: false };
}
