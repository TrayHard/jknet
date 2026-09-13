import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { JkhubRating as Rating } from "../../lib/ipc";

export function JkhubRating({ rating }: { rating: Rating | null }) {
  const { t } = useTranslation("jkhub");
  const value = Math.max(0, Math.min(5, rating?.value ?? 0));
  const label = rating
    ? t("details.ratingValue", { value: value.toFixed(1), count: rating.count })
    : t("details.notRated");
  return (
    <span className="inline-flex flex-wrap items-center gap-8 text-body-sm text-fg-muted" title={label}>
      <span role="img" aria-label={label} className="inline-flex gap-2 shrink-0">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} className="relative size-14">
            <Star size={14} aria-hidden />
            <span className="absolute inset-y-0 left-0 overflow-hidden text-fg-warm" style={{ width: `${Math.max(0, Math.min(1, value - index)) * 100}%` }}>
              <Star size={14} fill="currentColor" aria-hidden className="max-w-none" />
            </span>
          </span>
        ))}
      </span>
      <span>{t("card.reviews", { count: rating?.count ?? 0 })}</span>
    </span>
  );
}
