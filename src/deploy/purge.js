const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

export function purgeUrls({ hostname, paths }) {
  const urls = [];
  for (const path of paths) {
    urls.push(`https://${hostname}/${encodePath(path)}`);
    if (path.endsWith("/index.html")) {
      const directory = path.slice(0, -"index.html".length);
      urls.push(`https://${hostname}/${encodePath(directory)}`, `https://${hostname}/${encodePath(directory.slice(0, -1))}`);
    } else if (path === "index.html") urls.push(`https://${hostname}/`);
  }
  return urls;
}
