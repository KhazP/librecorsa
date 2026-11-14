import React from "react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";
import { CLASS_COLORS, type CarClassCode } from "./class-colors";

/** A car's class: its code in the class colour */
export const ClassTag: React.FC<{
  carClass: CarClassCode;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}> = ({ carClass, size = "md", variant = "soft", className = "" }) => {
  const c = CLASS_COLORS[carClass];
  return (
    <Badge tone={{ color: c.color }} variant={variant} size={size} className={className}>
      {c.label}
    </Badge>
  );
};
