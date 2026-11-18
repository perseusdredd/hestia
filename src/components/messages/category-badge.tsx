import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Emoji + name pill for a message category. */
export function CategoryBadge({
  category,
  className,
}: {
  category: { name: string; emoji: string };
  className?: string;
}) {
  return (
    <Badge variant="secondary" className={cn(className)}>
      <span aria-hidden>{category.emoji}</span>
      {category.name}
    </Badge>
  );
}
