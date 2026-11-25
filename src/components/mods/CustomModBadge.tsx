import React from "react";
import { Badge, type BadgeSize } from "@/components/ui/Badge";

export const CustomModBadge: React.FC<{
  size?: BadgeSize;
  className?: string;
}> = ({ size = "sm", className = "" }) => (
  <Badge
    tone="neutral"
    variant="outline"
    size={size}
    title="Mod de Assetto Corsa guardado en este navegador"
    className={className}
  >
    Mod local
  </Badge>
);
