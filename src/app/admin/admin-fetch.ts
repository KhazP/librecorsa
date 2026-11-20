import { onlineUrl } from "@/lib/net/online-config";

/**
 * One read of an admin route with the key. The key goes out only as `Authorization: Bearer` (a header Cloudflare's
 * logs redact): never in the URL, never with cookies, never as a referrer. The Worker answers a wrong key, a route
 * that is off and a fault alike, with the 404 of any unknown path, and a 429 past its limit.
 */
export type AdminRead<T> = { state: "ok"; body: T } | { state: "refused" } | { state: "busy" } | { state: "failed"; error?: string };

export async function readAdmin<T>(path: string, key: string): Promise<AdminRead<T>> {
  return sendAdmin<T>(path, key, { method: "GET" });
}

export async function sendAdmin<T>(
  path: string,
  key: string,
  opts: { method: "GET" | "POST" | "DELETE"; body?: unknown },
): Promise<AdminRead<T>> {
  const url = onlineUrl(path);
  if (!url) return { state: "failed" };
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (res.status === 404) return { state: "refused" };
    if (res.status === 429) return { state: "busy" };
    const parsed = (await res.json().catch(() => null)) as { error?: unknown } | T | null;
    if (!res.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" ? parsed.error : undefined;
      return { state: "failed", error };
    }
    return { state: "ok", body: parsed as T };
  } catch {
    return { state: "failed" };
  }
}
