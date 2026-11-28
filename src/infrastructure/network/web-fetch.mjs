import { lookup } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]]) {
  blocked.addSubnet(network, prefix, "ipv6");
}

function publicAddress(address) {
  return isIP(address) === 4 ? !blocked.check(address, "ipv4")
    : /^[23]/u.test(address) && !blocked.check(address, "ipv6");
}

// Check the addresses returned to the socket itself. A second DNS lookup
// between validation and connection could return a different address.
function publicLookup(host, options, callback) {
  lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      return callback(new Error("WebFetch requires a public web address"));
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

export function publicWebUrl(rawUrl, allowedHosts) {
  if (typeof rawUrl !== "string") throw Error("WebFetch requires a URL");
  const url = URL.parse(rawUrl);
  if (!url) throw new Error("WebFetch requires a public HTTP(S) URL");
  const host = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    host === "localhost" || host.endsWith(".localhost") || (isIP(host) && !publicAddress(host))) {
    throw new Error("WebFetch requires a public HTTP(S) URL without credentials");
  }
  if (allowedHosts && !allowedHosts.some(rule => rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule)) {
    throw new Error("WebFetch host is outside the task network allowlist");
  }
  return url;
}

export async function fetchWebPage(rawUrl, allowedHosts, signal) {
  let url = publicWebUrl(rawUrl, allowedHosts);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const client = url.protocol === "https:" ? https : http;
    const response = await new Promise((resolve, reject) => {
      client.get(url, { signal: timeout, lookup: publicLookup, headers: { accept: "text/*, application/json, application/xml", "accept-encoding": "identity" } }, resolve)
        .once("error", reject);
    });
    try {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        url = publicWebUrl(new URL(response.headers.location, url).href, allowedHosts);
        continue;
      }
      if (status < 200 || status >= 300) throw Error("WebFetch returned HTTP " + status);
      const type = response.headers["content-type"]?.split(";")[0]?.trim() ?? "";
      if (!type.startsWith("text/") && !/^application\/(?:json|xml|[^/]+\+(?:xml|json))$/u.test(type)) {
        throw Error("WebFetch expected a text page, received " + (type || "no content type"));
      }
      const encoding = response.headers["content-encoding"] ?? "identity";
      let stream = response;
      if (encoding !== "identity") {
        const decoder = new Map([["gzip", createGunzip], ["br", createBrotliDecompress], ["deflate", createInflate]]).get(encoding);
        if (!decoder) throw Error("Unsupported WebFetch content encoding: " + encoding);
        stream = response.compose(decoder(), { signal: timeout });
      }
      const charset = /;\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(response.headers["content-type"])?.[1] ?? "utf-8";
      const chunks = [];
      const limit = 96 * 1024;
      let size = 0;
      let truncated = false;
      for await (const chunk of stream) {
        const part = chunk.subarray(0, limit - size);
        chunks.push(part);
        size += part.length;
        if (part.length < chunk.length) { truncated = true; break; }
      }
      return { url: url.href, status, contentType: type, body: new TextDecoder(charset).decode(Buffer.concat(chunks, size)), truncated };
    } finally {
      response.destroy();
    }
  }
  throw Error("WebFetch exceeded five redirects");
}
