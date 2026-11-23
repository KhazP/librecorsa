import { securityTxt } from "@/lib/security-txt";

// Written once at build time, so its Expires counts from the deploy
export const dynamic = "force-static";

export function GET() {
  return new Response(securityTxt(new Date()), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
