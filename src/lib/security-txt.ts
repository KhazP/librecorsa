import { CONTACT_EMAIL, REPO_URL, SECURITY_REPORT_URL, SITE_URL } from "@/lib/site";

/** How long a build's security.txt stays valid: RFC 9116 wants under a year, and every deploy renews it */
export const SECURITY_TXT_VALID_DAYS = 180;

/** RFC 9116 security.txt, served at /.well-known/security.txt; SECURITY.md has the full policy */
export function securityTxt(builtAt: Date): string {
  const expires = new Date(builtAt.getTime() + SECURITY_TXT_VALID_DAYS * 86_400_000);
  return [
    `Contact: ${SECURITY_REPORT_URL}`,
    `Contact: mailto:${CONTACT_EMAIL}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "Preferred-Languages: en",
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    `Policy: ${REPO_URL}/blob/main/SECURITY.md`,
    "",
  ].join("\n");
}
