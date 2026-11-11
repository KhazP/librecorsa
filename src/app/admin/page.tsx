import type { Metadata } from "next";
import { AdminStats } from "./AdminStats";

// The owner's numbers. Not linked from anywhere and not indexed; the page itself holds no data: it asks the online
// side with the admin key (cloudflare/api/admin.ts), which answers no one else
export const metadata: Metadata = {
  title: "Numbers",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminPage() {
  return <AdminStats />;
}
