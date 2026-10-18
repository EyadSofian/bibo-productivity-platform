import type { SVGProps } from "react";

/**
 * One outline icon set, one stroke weight (1.75 on a 24 grid), coloured by
 * currentColor so every state comes from CSS. Drawn here rather than pulled
 * from a package: the admin needs ~40 glyphs and nothing else from a library.
 */
const PATHS = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4" /><path d="M18 14.8c1.9.7 3.2 2.5 3.5 5.2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20.5c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5" /></>,
  monitor: <><rect x="2.5" y="4" width="19" height="13" rx="2.5" /><path d="M8.5 20.5h7M12 17v3.5" /></>,
  live: <><rect x="2.5" y="5.5" width="13.5" height="13" rx="2.5" /><path d="m16 10.5 4.6-2.8a.6.6 0 0 1 .9.5v7.6a.6.6 0 0 1-.9.5L16 13.5" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2.2" /><circle cx="9" cy="17" r="2.2" /></>,
  tasks: <><path d="M9 6.5h11M9 12h11M9 17.5h11" /><path d="m3.5 6.5 1.3 1.3 2.2-2.6M3.5 12l1.3 1.3L7 10.7M3.5 17.5l1.3 1.3 2.2-2.6" /></>,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  logout: <><path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  language: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9S14.5 18.4 12 21c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-3.8L4 9" /><path d="M4 4.5V9h4.5M4 13a8 8 0 0 0 14.7 3.8L20 15" /><path d="M20 19.5V15h-4.5" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M6.5 14h.01M17.5 14h.01M9.5 14h5" /></>,
  mouse: <><rect x="6.5" y="3" width="11" height="18" rx="5.5" /><path d="M12 7v3.5" /></>,
  click: <><path d="m9 9 11 4-4.6 1.6L13.8 19Z" /><path d="M7.5 3.5 8.2 6M3.5 7.5 6 8.2M13 4.5l-1.3 2.1M4.5 13l2.1-1.3" /></>,
  scroll: <><path d="M12 3v18M8 6.5 12 3l4 3.5M8 17.5l4 3.5 4-3.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  coffee: <><path d="M4.5 9h12v5.5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5Z" /><path d="M16.5 10.5h1.2a2.6 2.6 0 0 1 0 5.2h-1.4M8 3.5v2.5M12 3.5v2.5" /></>,
  power: <><path d="M12 3v8" /><path d="M7 6.2a7.5 7.5 0 1 0 10 0" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  app: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01" /></>,
  activity: <path d="M3 12h4l2.5-6.5 5 13L17 12h4" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5M12 17.2h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  building: <><rect x="4" y="3" width="11" height="18" rx="1.5" /><path d="M15 9h3.5a1.5 1.5 0 0 1 1.5 1.5V21M8 7h3M8 11h3M8 15h3M3 21h18" /></>,
  shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  play: <path d="M8 5.5v13a.6.6 0 0 0 .9.5l10.4-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>,
  restore: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>,
  trash: <><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12.5" /></>,
  edit: <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 13 9 5 9-5" /></>,
  sparkle: <path d="M12 3c.6 4.3 2.7 6.4 7 7-4.3.6-6.4 2.7-7 7-.6-4.3-2.7-6.4-7-7 4.3-.6 6.4-2.7 7-7Z" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3.5 9h17M3.5 15h17M12 3c-2.4 2.5-3.5 5.5-3.5 9s1.1 6.5 3.5 9M12 3c2.4 2.5 3.5 5.5 3.5 9s-1.1 6.5-3.5 9" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9.5 9.5h5v5h-5ZM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  phone: <path d="M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5C10.6 20 4 13.4 3.5 5.6A1.5 1.5 0 0 1 5 4Z" />,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".6" /></>,
  at: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>,
  lock: <><rect x="4" y="10.5" width="16" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" /></>,
  download: <><path d="M12 3.5v12M7 11l5 5 5-5" /><path d="M4.5 20h15" /></>,
  wifiOff: <><path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.6-2.8M14 10.4A10 10 0 0 1 19 13M2 9.3a15 15 0 0 1 5-2.9M11.3 5.6A15 15 0 0 1 22 9.3" /><path d="M12 20h.01" /></>,
} as const;

export type IconName = keyof typeof PATHS;

type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  /** Accessible label. Without one the icon is decorative and hidden. */
  label?: string;
};

export function Icon({ name, label, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
