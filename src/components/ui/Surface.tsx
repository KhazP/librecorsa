import React, { useId } from "react";
import { cx } from "./styles";

type DivProps = React.HTMLAttributes<HTMLDivElement>;

/** The frosted sheet over the scene (`.lc-glass`): one per screen region */
export function Sheet({ className, children, ...rest }: DivProps) {
  return (
    <div {...rest} className={cx("lc-glass rounded-lc-sheet p-5 text-lc-chalk shadow-lc-sheet phone:p-4", className)}>
      {children}
    </div>
  );
}

/** A card's heading: an `h3` in `lc-h3`. A card names itself with this, never with a dot and tracked caps. */
export function CardTitle({
  as: Tag = "h3",
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return (
    <Tag {...rest} className={cx("lc-h3 min-w-0", className)}>
      {children}
    </Tag>
  );
}

export interface CardProps extends Omit<DivProps, "title"> {
  /** Plain heading (renders `CardTitle`) */
  title?: React.ReactNode;
  /** Right of the title: a reset button, a status badge */
  action?: React.ReactNode;
  /** One line under the title */
  description?: React.ReactNode;
  /** Classes of the body that holds the children, in place of its 4 px row gap (a card of blocks, not rows) */
  bodyClassName?: string;
}

/**
 * Content inside a sheet: carbon at 80 %, a white 7 % hairline, no blur, no shadow. Never a card in a card: a group
 * inside a card is a `Well`. Rows go in as children; they sit 4 px apart and bleed 8 px into the padding, so a
 * row's label lines up with the title.
 */
export function Card({ title, action, description, bodyClassName, className, children, ...rest }: CardProps) {
  const titleId = useId();
  return (
    <section
      {...rest}
      aria-labelledby={title ? titleId : rest["aria-labelledby"]}
      className={cx(
        "flex min-w-0 flex-col gap-3 rounded-lc-card border border-white/7 bg-lc-carbon/80 p-4.5 text-lc-chalk phone:p-3.5",
        className,
      )}
    >
      {title || action ? (
        <div className="flex min-h-8 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            {title ? <CardTitle id={titleId}>{title}</CardTitle> : null}
            {description ? <p className="lc-hint m-0">{description}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      <div className={cx("flex min-w-0 flex-col", bodyClassName ?? "gap-1")}>{children}</div>
    </section>
  );
}

/** An inset well inside a card: inputs, stat tiles, read-outs */
export function Well({ className, children, ...rest }: DivProps) {
  return (
    <div {...rest} className={cx("rounded-lc-row border border-lc-line bg-lc-well", className)}>
      {children}
    </div>
  );
}
