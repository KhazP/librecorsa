import React, { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CareerKitClient } from "./CareerKitClient";

export const metadata: Metadata = {
  title: "Career mode kit",
  robots: { index: false, follow: false },
};

/** Development-only preview of CareerScreen with a realistic sample save built from career-state functions. */
export default function CareerKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <CareerKitClient />
    </Suspense>
  );
}
