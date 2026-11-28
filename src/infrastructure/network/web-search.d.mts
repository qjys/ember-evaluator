export function fetchWeb(url: string, allowedHosts: string[] | undefined, signal: AbortSignal): Promise<{
  backend: "exa" | "http-fetch"; url: string; body: string; truncated: boolean;
}>;
export function searchWeb(query: string, signal: AbortSignal): Promise<{
  backend: "exa"; results: { url: string; title: string }[]; content: string;
}>;
