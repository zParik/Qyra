import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * The one button family. Voices: primary (rose, one per view), secondary
 * (bordered paper), ghost (bare), danger, icon (square). Styles live in
 * styles.css under `.btn-*` so plain markup and this component stay identical.
 */
const button = cva("", {
  variants: {
    variant: {
      primary: "btn-primary",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      danger: "btn-danger",
      icon: "btn-icon",
    },
    size: { md: "", sm: "btn-sm" },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = "button", ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={clsx(button({ variant, size }), className)} {...rest} />;
});
