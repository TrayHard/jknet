import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SortDirection } from "../../lib/ipc";
import { Button, Select, type SelectOption } from "../ui";

export function LibrarySort({ value, onChange, options, direction, onDirection }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  direction: SortDirection;
  onDirection: (direction: SortDirection) => void;
}) {
  const { t } = useTranslation("library");
  const ascending = direction === "asc";
  const action = t(ascending ? "sort.setDescending" : "sort.setAscending");
  return (
    <div className="flex items-center gap-8 shrink-0">
      <Select
        ariaLabel={t("sort.label")}
        options={options}
        value={value}
        onChange={onChange}
        className="w-176"
      />
      <Button
        icon={ascending ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
        aria-label={action}
        title={action}
        onClick={() => onDirection(ascending ? "desc" : "asc")}
        className="min-w-80"
      >
        {t(ascending ? "sort.ascending" : "sort.descending")}
      </Button>
    </div>
  );
}
