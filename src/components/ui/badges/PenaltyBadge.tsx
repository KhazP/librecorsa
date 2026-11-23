import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
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
  const tx = useTranslations("common.penalty");
  const seconds = penalty.kind === "time" ? penalty.seconds : 0;
  const strikes = penalty.kind === "trackLimits" ? penalty.strikes : 0;
  const of = penalty.kind === "trackLimits" ? penalty.of : 0;
  // The timing tower redraws it many times a second: the words are resolved when the penalty or the language changes
  const words = useMemo(() => {
    switch (penalty.kind) {
      case "time":
        return tx("time", { seconds: String(seconds) });
      case "trackLimits":
        return tx("trackLimits", { strikes: String(strikes), of: String(of) });
      default:
        return tx(penalty.kind);
    }
  }, [tx, penalty.kind, seconds, strikes, of]);
  const common = { size, variant, className };
  switch (penalty.kind) {
    case "time":
      return (
        <Badge tone="bad" icon="penalty" {...common}>
          {words}
        </Badge>
      );
    case "driveThrough":
      return (
        <Badge tone="bad" icon="pitLane" {...common}>
          {words}
        </Badge>
      );
    case "warning":
      return (
        <Badge tone="warn" leading={<FlagIcon flag="blackWhite" size={FLAG_PX[size]} />} {...common}>
          {words}
        </Badge>
      );
    case "trackLimits":
      return (
        <Badge tone="warn" icon="trackLimits" {...common}>
          {words}
        </Badge>
      );
    case "disqualified":
      return (
        <Badge tone="bad" leading={<FlagIcon flag="black" size={FLAG_PX[size]} />} {...common}>
          {words}
        </Badge>
      );
  }
};
