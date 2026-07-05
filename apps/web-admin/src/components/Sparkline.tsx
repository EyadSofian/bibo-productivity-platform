import { useId } from "react";

/**
 * Tiny inline sparkline (smooth line + soft gradient fill + end dot).
 * Purely presentational — pass a numeric series and a stroke color.
 * The path is a Catmull-Rom spline converted to cubic béziers so the
 * curve reads the same as the offline design reference.
 */
export function Sparkline({
  data,
  width = 60,
  height = 22,
  color,
  strokeWidth = 2,
  pad = 3,
}: {
  data: number[];
  width?: number;
  height?: number;
  color: string;
  strokeWidth?: number;
  pad?: number;
}) {
  const gid = useId().replace(/[:]/g, "");
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => ({
    x: pad + i * stepX,
    // higher value → higher on screen (smaller y)
    y: pad + (1 - (v - min) / span) * (height - pad * 2),
  }));

  // Catmull-Rom → cubic bézier
  let line = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    line += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  const fill = `${line} L ${pts[pts.length - 1].x} ${height} L ${pts[0].x} ${height} Z`;
  const last = pts[pts.length - 1];

  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={strokeWidth * 1.3} fill={color} />
    </svg>
  );
}
