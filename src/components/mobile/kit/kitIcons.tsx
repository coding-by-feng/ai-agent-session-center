/**
 * Glyphs for the phone kit (AASC-38): tab bar, navigation, banners. 24px grid,
 * drawn in currentColor, decorative: whatever wears one names itself in words.
 * The session header / key bar glyphs stay in ../phoneIcons.tsx.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ children, size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Sessions tab: stacked session cards. */
export const SessionsTabIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="7" width="18" height="13" rx="3" />
    <path d="M6 4h12" />
    <path d="M7 12h6M7 16h10" />
  </Svg>
);

/** Inbox tab: a tray. */
export const InboxTabIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13l2.6-7.2A2 2 0 0 1 7.5 4.5h9a2 2 0 0 1 1.9 1.3L21 13" />
    <path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-5.5a3.5 3.5 0 0 1-7 0z" />
  </Svg>
);

/** Queue tab: an ordered list. */
export const QueueTabIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6h12M9 12h12M9 18h12" />
    <path d="M4 5.5l1-.8V8M3.8 11.2a1.1 1.1 0 1 1 1.9.8L3.8 14h2.2M3.9 16.6h1.6a.9.9 0 0 1 0 1.8h-.8.8a.9.9 0 0 1 0 1.8H3.9" strokeWidth="1.4" />
  </Svg>
);

/** More tab: three dots in a circle. */
export const MoreTabIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="8" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="16" cy="12" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => <Svg size={18} {...p}><polyline points="9 6 15 12 9 18" /></Svg>;

export const ChevronLeftIcon = (p: IconProps) => <Svg size={26} strokeWidth="2.2" {...p}><polyline points="15 5 8 12 15 19" /></Svg>;

export const EllipsisIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => <Svg size={20} {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;

export const InfoIcon = (p: IconProps) => (
  <Svg size={20} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.6" r="0.9" fill="currentColor" stroke="none" /></Svg>
);

export const WarningIcon = (p: IconProps) => (
  <Svg size={20} {...p}><path d="M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4.5" /><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" /></Svg>
);

export const ErrorIcon = (p: IconProps) => (
  <Svg size={20} {...p}><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></Svg>
);

export const SuccessIcon = (p: IconProps) => (
  <Svg size={20} {...p}><circle cx="12" cy="12" r="9" /><polyline points="8 12.5 11 15.5 16.5 9.5" /></Svg>
);

export const OfflineIcon = (p: IconProps) => (
  <Svg size={20} {...p}><path d="M2 8.8a15 15 0 0 1 4.2-2.6M9.8 5.2A15 15 0 0 1 22 8.8M5 12.4a10 10 0 0 1 3.4-2M14.5 10.4A10 10 0 0 1 19 12.4M8.5 16a5 5 0 0 1 7 0" /><path d="M3 3l18 18" /><circle cx="12" cy="19.5" r="0.9" fill="currentColor" stroke="none" /></Svg>
);

/** An interrupted turn (stopped by an API error, a limit or the network). */
export const InterruptedIcon = (p: IconProps) => (
  <Svg size={14} {...p}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><polyline points="20 4 20 8 16 8" /></Svg>
);

export const GalleryIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></Svg>
);
