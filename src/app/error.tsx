"use client";

import { useEffect } from "react";
import { SiteNotice } from "@/components/home/SiteNotice";

/** A page around the game that failed while drawing (the game's own failures go to play/error.tsx) */
export default function SiteError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <SiteNotice title="Something went wrong">This page stopped with an error.</SiteNotice>;
}
