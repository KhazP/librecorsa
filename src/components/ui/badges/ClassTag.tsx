import React from "react";
import { useTranslations } from "use-intl/react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";
import { CLASS_COLORS, type CarClassCode } from "./class-colors";

/** A car's class: its code in the class colour */
export const ClassTag: React.FC<{
  carClass: CarClassCode;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}> = ({ carClass, size = "md", variant = "soft", className = "" }) => {
  // The name from the messages, not `CLASS_COLORS`: that table is plain data the home page's server render reads
  const tx = useTranslations("common.carClass");
  const c = CLASS_COLORS[carClass];
  return (
    <Badge tone={{ color: c.color }} variant={variant} size={size} className={className}>
      {tx(carClass)}
    </Badge>
  );
};
