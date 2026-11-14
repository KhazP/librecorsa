import React from "react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";
import { FlagIcon } from "./FlagIcon";

export type Penalty =
  | { kind: "time"; seconds: number }
  | { kind: "driveThrough" }
  | { kind: "warning" }
  | { kind: "trackLimits"; strikes: number; of: number }
  | { kind: "disqualified" };

const FLAG_PX: Record<BadgeSize, number> = { lg: 20, md: 18, sm: 16, hud: 14 };

/** A penalty or warning from race control: its icon and its words */
export const PenaltyBadge: React.FC<{
  penalty: Penalty;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}> = ({ penalty, size = "md", variant = "soft", className = "" }) => {
  const common = { size, variant, className };
  switch (penalty.kind) {
    case "time":
      return (
        <Badge tone="bad" icon="penalty" {...common}>
          +{penalty.seconds} s
        </Badge>
      );
    case "driveThrough":
      return (
        <Badge tone="bad" icon="pitLane" {...common}>
          Drive-through
        </Badge>
      );
    case "warning":
      return (
        <Badge tone="warn" leading={<FlagIcon flag="blackWhite" size={FLAG_PX[size]} />} {...common}>
          Warning
        </Badge>
      );
    case "trackLimits":
      return (
        <Badge tone="warn" icon="trackLimits" {...common}>
          Track limits {penalty.strikes}/{penalty.of}
        </Badge>
      );
    case "disqualified":
      return (
        <Badge tone="bad" leading={<FlagIcon flag="black" size={FLAG_PX[size]} />} {...common}>
          Disqualified
        </Badge>
      );
  }
};
