"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import { Modal } from "@/components/ui";
import type { SessionLapEntry } from "@/lib/sim/lap-analysis";
import type { LapRecording } from "@/lib/sim/lap-types";
import type { TurnMetadata } from "@/types/f1";
import { LapTelemetryView } from "./LapTelemetryView";

export interface LapTelemetryModalProps {
  open: boolean;
  sessionLaps: readonly SessionLapEntry[];
  bestLap?: LapRecording | null;
  latestLap?: LapRecording | null;
  turns?: readonly TurnMetadata[];
  sectorSplitsM?: readonly [number, number] | null;
  trackName: string;
  onClose: () => void;
}

export const LapTelemetryModal: React.FC<LapTelemetryModalProps> = ({
  open,
  sessionLaps,
  bestLap = null,
  latestLap = null,
  turns = [],
  sectorSplitsM = null,
  trackName,
  onClose,
}) => {
  const tx = useTranslations("hud.lapTelemetry");
  return (
    <Modal open={open} onClose={onClose} size="lg" title={tx("title")} subtitle={<span className="lc-hint">{trackName}</span>}>
      <LapTelemetryView
        sessionLaps={sessionLaps}
        bestLap={bestLap}
        latestLap={latestLap}
        turns={turns}
        sectorSplitsM={sectorSplitsM}
        embedded={false}
      />
    </Modal>
  );
};
