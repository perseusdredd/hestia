import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Styled native <select>. Prefer this inside plain <form action> flows: it
 * posts its value with FormData and shows option labels without extra setup
 * (the base-ui Select needs an `items` prop to display labels).
 */
export function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        data-slot="native-select"
        className="h-8 w-full appearance-none pointer-coarse:h-10 rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/15"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}
