export function publicWebUrl(rawUrl: unknown, allowedHosts: string[] | undefined): URL;

export function fetchWebPage(rawUrl: unknown, allowedHosts: string[] | undefined, signal: AbortSignal): Promise<{
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}>;
