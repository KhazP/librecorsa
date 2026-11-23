"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/ui/icons/Icon";

/** Copies text where the clipboard API is missing or refused (an older Safari): a hidden text area and the copy command */
function copyByCommand(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * `?perf=1`: the pause menu's way out for the whole-session performance report (render/session-perf.ts). A phone has
 * no console, so the player copies it or saves it as a file and sends it.
 */
export function PerfReportCard({ report }: { report: () => string }) {
  const tx = useTranslations("hud.perfReportCard");
  const [done, setDone] = useState<"copied" | "saved" | "failed" | null>(null);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(null), 2500);
    return () => window.clearTimeout(id);
  }, [done]);

  const copy = () => {
    // Read now, inside the click: the clipboard only takes a write that a press started
    const text = report();
    const fallback = () => setDone(copyByCommand(text) ? "copied" : "failed");
    if (!navigator.clipboard?.writeText) return fallback();
    navigator.clipboard.writeText(text).then(() => setDone("copied"), fallback);
  };
  const save = () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const url = URL.createObjectURL(new Blob([report()], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `librecorsa-performance-${stamp}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setDone("saved");
  };

  return (
    <Card
      title={tx("title")}
      description={done === "failed" ? tx("failed") : tx("description")}
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" icon={<Icon name={done === "copied" ? "copied" : "copy"} />} onClick={copy}>
          {done === "copied" ? tx("copied") : tx("copy")}
        </Button>
        <Button variant="secondary" size="sm" icon={<Icon name="download" />} onClick={save}>
          {done === "saved" ? tx("saved") : tx("saveFile")}
        </Button>
      </div>
    </Card>
  );
}
