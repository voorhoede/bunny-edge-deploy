const HASHED = /[.\-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  map: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

export const isHashedAsset = (path) => HASHED.test(path);

export const contentTypeFor = (path) => CONTENT_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];

export function planUpload({ local, remote, statePath }) {
  const remoteByPath = new Map(remote.map((file) => [file.path, file]));
  const localPaths = new Set(local.map((file) => file.path));
  const upload = local.filter((file) => remoteByPath.get(file.path)?.checksum !== file.checksum);
  const hashed = upload.filter((file) => isHashedAsset(file.path));
  const unhashed = upload.filter((file) => !isHashedAsset(file.path));
  return {
    upload: [...hashed, ...unhashed],
    unchanged: local.filter((file) => remoteByPath.get(file.path)?.checksum === file.checksum).map((file) => file.path),
    stale: remote.map((file) => file.path).filter((path) => !localPaths.has(path) && path !== statePath),
    changedUnhashed: unhashed.map((file) => file.path),
  };
}
