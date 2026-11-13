"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export function CopyButton({
  value,
  label = "Kopyala",
  ...props
}: { value: string; label?: string } & Omit<React.ComponentProps<typeof Button>, "onClick">) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Panoya kopyalandı.");
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error("Kopyalanamadı. Bağlantıyı elle seçip kopyalayın.");
        }
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {label}
    </Button>
  );
}
