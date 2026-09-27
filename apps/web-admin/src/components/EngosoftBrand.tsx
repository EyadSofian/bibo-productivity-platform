type EngosoftBrandProps = {
  compact?: boolean;
  className?: string;
};

/** Wordmark only: the old circular mark has been retired from the admin UI. */
export function EngosoftBrand({ compact = false, className = "" }: EngosoftBrandProps) {
  const classes = ["engosoft-brand", compact ? "engosoft-brand--compact" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} aria-label="Engosoft Workforce">
      {!compact && (
        <span className="engosoft-brand__wordmark" aria-hidden>
          <strong>Engosoft</strong>
        </span>
      )}
    </span>
  );
}
