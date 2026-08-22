import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Reference implementation of the CVA pattern used across this project.
 *
 * Shared classes live in the base string; each variant holds only what
 * differs. Colors come from `ploy-*` token classes so the component re-themes
 * with the workspace brand — see AGENTS.md, "Styling with ploy tokens".
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button font-button text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ploy-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-ploy-background-primary disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "border border-ploy-button-primary-border bg-ploy-button-primary-background text-ploy-button-primary-text hover:bg-ploy-button-primary-background/90",
        secondary:
          "border border-ploy-button-secondary-border bg-ploy-button-secondary-background text-ploy-button-secondary-text hover:bg-ploy-button-secondary-background/90",
        outline:
          "border border-ploy-border-primary bg-transparent text-ploy-text-primary hover:bg-ploy-neutral-primary-s2",
        ghost: "text-ploy-text-primary hover:bg-ploy-neutral-primary-s2",
        link: "text-ploy-accent-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4",
        lg: "h-12 px-6 text-base",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element instead of a `<button>` (e.g. an `<a>`). */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
