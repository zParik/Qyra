import { clsx, type ClassValue } from "clsx";
import { cva, type VariantProps } from "class-variance-authority";

export { cva, type VariantProps };

/** Merge Tailwind classes without conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
