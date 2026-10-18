/**
 * The Engosoft mark: three slanted capsules and the orange dot, traced from the
 * brand logo (capsules at -18.4°, dot #FF6500). Vector, so it stays crisp at
 * every size and recolours with `currentColor`.
 */
export function EngosoftMark({ className, dot = "#FF6500" }: { className?: string; dot?: string }) {
  return (
    <svg className={className} viewBox="0 0 110 150" aria-hidden focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="29.4" strokeLinecap="round">
        <path d="M14.7 41.7 52.6 29.1M14.7 87.7 94.6 61.1M14.7 134.2 94.6 107.6" />
      </g>
      <circle cx="93" cy="15" r="14.5" fill={dot} />
    </svg>
  );
}

/** Mark + "engosoft" wordmark + product line. */
export function BrandLockup({ product, inverse = false }: { product?: string; inverse?: boolean }) {
  return (
    <span className={`brand${inverse ? " brand-inverse" : ""}`} aria-label={product ? `Engosoft ${product}` : "Engosoft"}>
      <EngosoftMark className="brand-mark" />
      <span className="brand-text" aria-hidden>
        <span className="brand-word">engosoft</span>
        {product ? <span className="brand-product">{product}</span> : null}
      </span>
    </span>
  );
}
