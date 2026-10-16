/**
 * Glyphs for the phone's project browser and the queue's photo buttons
 * (AASC-20). 20px, currentColor, decorative: every control that wears one
 * names itself in words (aria-label or visible text).
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
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

export const PhotoIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="M21 16l-5-5-9 9" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="4" />
  </Svg>
);

export const BackIcon = (p: IconProps) => <Svg {...p}><polyline points="15 18 9 12 15 6" /></Svg>;

export const ChevronIcon = (p: IconProps) => <Svg {...p}><polyline points="9 6 15 12 9 18" /></Svg>;

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16" y2="16" />
  </Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></Svg>
);

export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    <polyline points="14 3 14 8 19 8" />
  </Svg>
);

export const OutlineIcon = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="8" y1="12" x2="20" y2="12" />
    <line x1="12" y1="18" x2="20" y2="18" />
  </Svg>
);

export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </Svg>
);

export const CollapseIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </Svg>
);

export const ZoomInIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16" y2="16" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </Svg>
);

export const ZoomOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16" y2="16" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </Svg>
);

/** Open and recent files (AASC-56): stacked pages. */
export const FilesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3h8l4 4v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <polyline points="16 3 16 7 20 7" />
    <path d="M4 7v13a1 1 0 0 0 1 1h10" />
  </Svg>
);

/** Find in the open file (AASC-56): a magnifier over lines of text. */
export const FindInFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="14" y2="6" />
    <line x1="4" y1="11" x2="9" y2="11" />
    <line x1="4" y1="16" x2="8" y2="16" />
    <circle cx="15" cy="15" r="4" />
    <line x1="21" y1="21" x2="18" y2="18" />
  </Svg>
);

export const UpIcon = (p: IconProps) => <Svg {...p}><polyline points="6 15 12 9 18 15" /></Svg>;

export const DownIcon = (p: IconProps) => <Svg {...p}><polyline points="6 9 12 15 18 9" /></Svg>;

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </Svg>
);
