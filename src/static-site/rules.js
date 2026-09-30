import { deployFolder } from "../deploy/deploy-folder.js";

export const DEPLOY_HEADER = "X-Bunny-Deploy";
// The action finds its own rules again by this prefix, so descriptions must not change.
export const RULE_PREFIX = "bunny-edge-deploy: ";

const ACTION = { redirect: 1, blockRequest: 4, setResponseHeader: 5, overrideBrowserCacheTime: 16, originStorage: 17 };
const TRIGGER = { url: 0, urlExtension: 3 };
const MATCH = { any: 0, none: 2 };
// Bunny accepts at most five patterns per trigger and five triggers per rule.
const PATTERNS_PER_TRIGGER = 5;
const TRIGGERS_PER_RULE = 5;
const REDIRECT_STATUSES = [301, 302, 307, 308];
const ASSET_EXTENSION_GROUPS = [["css", "js", "mjs", "woff2", "svg"], ["png", "jpg", "jpeg", "webp", "ico"], ["wasm", "onnx", "woff", "ttf", "otf"]];

const rule = (description, fields) => ({ Description: `${RULE_PREFIX}${description}`, Enabled: true, ...fields });
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const isNamed = (name) => ([header]) => header.toLowerCase() === name;

// `*` in a Url trigger also crosses the host, so `*://*/old` would match `/x/old`; a Lua pattern anchors the path.
// Bunny refuses a pattern that does not end in `$`.
const DEPLOYS_PATTERN = "pattern:^https?://[^/]+/deploys/.*$";

const isMatchable = (path) => !path.includes(":") && !path.slice(0, -1).includes("*");
const isWildcard = (path) => path.endsWith("*");
const withoutSlash = (path) => path.replace(/(.)\/+$/, "$1");

function pathPattern(path) {
  const escape = (text) => text.replace(/[\^$()%.[\]*+\-?]/g, (character) => `%${character}`);
  if (path.endsWith("*")) return `pattern:^https?://[^/]+${escape(path.slice(0, -1))}.*$`;
  return `pattern:^https?://[^/]+${escape(path.replace(/\/+$/, ""))}/?$`;
}

const pathTriggers = (paths) => chunk(paths.map(pathPattern), PATTERNS_PER_TRIGGER).map((patterns) => ({ Type: TRIGGER.url, PatternMatches: patterns, PatternMatchingType: MATCH.any }));

const setHeaders = ([first, ...rest]) => ({
  ActionType: ACTION.setResponseHeader,
  ActionParameter1: first[0],
  ActionParameter2: first[1],
  ExtraActions: rest.map(([name, value]) => ({ ActionType: ACTION.setResponseHeader, ActionParameter1: name, ActionParameter2: value })),
});

export function siteRules({ storageZone, deployId, files = [], headers = [], redirects = [] }) {
  const blocks = headers.filter(({ path }) => isMatchable(path));
  const cacheRules = browserCacheRules(blocks);
  return [
    rule("serve the published deploy", {
      ActionType: ACTION.originStorage,
      ActionParameter1: String(storageZone.Id),
      ActionParameter2: storageZone.Name,
      ActionParameter3: `/${deployFolder(deployId)}/`,
      ExtraActions: [{ ActionType: ACTION.setResponseHeader, ActionParameter1: DEPLOY_HEADER, ActionParameter2: deployId }],
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.url, PatternMatches: [DEPLOYS_PATTERN], PatternMatchingType: MATCH.none }],
    }),
    rule("block deploy folders", {
      ActionType: ACTION.blockRequest,
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.url, PatternMatches: [DEPLOYS_PATTERN], PatternMatchingType: MATCH.any }],
    }),
    rule("block host config files", {
      ActionType: ACTION.blockRequest,
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.url, PatternMatches: ["*/_headers", "*/_redirects"], PatternMatchingType: MATCH.any }],
    }),
    ...(cacheRules.length > 0 ? cacheRules : ASSET_EXTENSION_GROUPS.map((extensions, index) => rule(`browser-cache static assets (${index + 1})`, {
      ActionType: ACTION.overrideBrowserCacheTime,
      ActionParameter1: "86400",
      TriggerMatchingType: MATCH.any,
      Triggers: [{ Type: TRIGGER.urlExtension, PatternMatches: extensions, PatternMatchingType: MATCH.any }],
    }))),
    ...wildcardHeaderRules(blocks),
    ...pageHeaderRules(blocks, servedPages(files, redirects)),
    ...redirects.map(redirectRule),
  ];
}

// The zone's Cache-Control override rewrites any header set on a response, so a max-age becomes the browser cache time.
function browserCacheRules(blocks) {
  return blocks.flatMap(({ path, headers }) => {
    const maxAge = headers.find(isNamed("cache-control"))?.[1].match(/max-age=(\d+)/)?.[1];
    if (maxAge === undefined) return [];
    return [rule(`browser cache ${path}`, {
      ActionType: ACTION.overrideBrowserCacheTime,
      ActionParameter1: maxAge,
      TriggerMatchingType: MATCH.any,
      Triggers: pathTriggers([path]),
    })];
  });
}

const ruleHeaders = (headers) => headers.filter((header) => !isNamed("cache-control")(header) && !isNamed("location")(header));

// The pages a build serves, without the pages Astro writes for a redirect, which carry no headers.
function servedPages(files, redirects) {
  const redirected = new Set(redirects.map(({ from }) => withoutSlash(from)));
  return files
    .filter((file) => file.endsWith(".html"))
    .map((file) => withoutSlash(`/${file.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "")}`))
    .filter((path) => !redirected.has(path));
}

function wildcardHeaderRules(blocks) {
  return blocks.filter(({ path }) => isWildcard(path)).flatMap(({ path, headers }) => {
    const applied = ruleHeaders(headers);
    if (applied.length === 0) return [];
    return [rule(`headers ${path}`, { ...setHeaders(applied), TriggerMatchingType: MATCH.any, Triggers: pathTriggers([path]) })];
  });
}

// Headers go on every URL only when every page has them; a block for one page must not reach the whole site.
function pageHeaderRules(blocks, served) {
  const pages = blocks.filter(({ path }) => !isWildcard(path)).map(({ path, headers }) => ({ path, headers: ruleHeaders(headers) }));
  const key = ([name, value]) => `${name.toLowerCase()}: ${value}`;
  const covered = new Set(pages.map(({ path }) => withoutSlash(path)));
  const everyPageCovered = pages.length > 0 && served.every((path) => covered.has(path));
  const shared = !everyPageCovered ? [] : pages[0].headers.filter((header) => pages.every((page) => page.headers.some((other) => key(other) === key(header))));
  const sharedKeys = new Set(shared.map(key));

  const groups = new Map();
  for (const page of pages) {
    const own = page.headers.filter((header) => !sharedKeys.has(key(header)));
    if (own.length === 0) continue;
    const id = own.map(key).join("\n");
    groups.set(id, { headers: own, paths: [...(groups.get(id)?.paths ?? []), page.path] });
  }

  const pageRules = [...groups.values()]
    .flatMap(({ headers, paths }) => chunk(paths, PATTERNS_PER_TRIGGER * TRIGGERS_PER_RULE).map((group) => ({ headers, paths: group })))
    .map(({ headers, paths }, index) => rule(`page headers (${index + 1})`, { ...setHeaders(headers), TriggerMatchingType: MATCH.any, Triggers: pathTriggers(paths) }));
  const everyPage = shared.length === 0 ? [] : [rule("headers for every page", {
    ...setHeaders(shared),
    TriggerMatchingType: MATCH.any,
    Triggers: [{ Type: TRIGGER.url, PatternMatches: ["*"], PatternMatchingType: MATCH.any }],
  })];
  return [...everyPage, ...pageRules];
}

function redirectError({ from, to, status }) {
  if (!to) return `_redirects line for ${from} has no target`;
  if (!REDIRECT_STATUSES.includes(status)) return `_redirects sends ${from} with status ${status}, but a Bunny redirect rule takes 301, 302, 307 or 308`;
  return undefined;
}

// Bunny refuses a relative redirect target, so a path goes to the host the visitor asked for.
function redirectRule({ from, to, status }) {
  const error = redirectError({ from, to, status });
  if (error) throw new Error(error);
  return rule(`redirect ${from}`, {
    ActionType: ACTION.redirect,
    ActionParameter1: to.startsWith("/") ? `https://%{Url.Hostname}${to}` : to,
    ActionParameter2: String(status),
    TriggerMatchingType: MATCH.any,
    Triggers: pathTriggers([from]),
  });
}

export function analyzeSiteConfig({ headers = [], redirects = [] }) {
  const errors = redirects.map(redirectError).filter(Boolean);
  const warnings = [];
  for (const { path, headers: blockHeaders } of headers) {
    if (!isMatchable(path)) {
      warnings.push(`_headers path ${path} cannot be matched by an edge rule, which takes a * only at the end and no :placeholder; its headers are not applied`);
      continue;
    }
    for (const [name, value] of blockHeaders.filter(isNamed("cache-control"))) {
      if (!/max-age=\d+/.test(value)) warnings.push(`_headers for ${path}: ${name}: ${value} has no max-age, and only a max-age becomes a Bunny browser cache time; it is not applied`);
    }
  }
  const redirecting = headers.filter(({ headers: blockHeaders }) => blockHeaders.some(isNamed("location"))).map(({ path }) => path);
  if (redirecting.length > 0) warnings.push(`not redirected by the CDN, only by the page's own meta refresh: ${redirecting.join(", ")}`);
  return { errors, warnings };
}

// The 404 path is a storage zone setting, so it moves with every publish; the API only clears it with an empty path.
export function notFoundSettings({ deployId, files }) {
  return { Custom404FilePath: files.includes("404.html") ? `/${deployFolder(deployId)}/404.html` : "", Rewrite404To200: false };
}
