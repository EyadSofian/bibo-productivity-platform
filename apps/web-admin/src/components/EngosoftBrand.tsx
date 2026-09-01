type EngosoftBrandProps = {
  compact?: boolean;
  className?: string;
};

/**
 * Code-native Engosoft lockup for crisp rendering across themes and DPIs.
 * The geometry follows the supplied Engosoft mark while keeping the product
 * name readable in the admin shell and authentication surfaces.
 */
export function EngosoftBrand({ compact = false, className = "" }: EngosoftBrandProps) {
  const classes = ["engosoft-brand", compact ? "engosoft-brand--compact" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} aria-label="Engosoft Workforce">
      <svg className="engosoft-brand__mark" viewBox="0 0 48 48" role="img" aria-hidden>
        <path
          className="engosoft-brand__orbit"
          d="M41 24A17 17 0 1 0 24 41"
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          className="engosoft-brand__e"
          d="M14 24.5c.8-6.1 5.1-10.2 11-10.2 6.6 0 10.7 4.5 10.7 10.8H15.2c.6 5.2 4.4 8.5 10 8.5 3.5 0 6.2-1 8.8-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="5.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle className="engosoft-brand__dot" cx="27.8" cy="40.7" r="1.7" fill="currentColor" />
        <circle className="engosoft-brand__dot" cx="33.1" cy="38.8" r="1.35" fill="currentColor" />
      </svg>
      {!compact && (
        <span className="engosoft-brand__wordmark" aria-hidden>
          <strong>ENGO</strong>
          <strong>SOFT</strong>
        </span>
      )}
    </span>
  );
}
