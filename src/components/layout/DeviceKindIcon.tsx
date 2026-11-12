/**
 * DeviceKindIcon — a computer, phone or tablet outline (Nov 2 2026), drawn in `currentColor`
 * so it follows the theme, where the 🖥 / 📱 emoji it replaces drew a phone for an iPad too.
 */
import type { ReactNode } from 'react';
import type { DeviceKind } from '@/lib/deviceKind';

const PATHS: Record<DeviceKind, ReactNode> = {
  computer: (
    <>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M6 14h4M8 11v3" />
    </>
  ),
  phone: (
    <>
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
    </>
  ),
  tablet: (
    <>
      <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
      <path d="M7 12.5h2" />
    </>
  ),
};

export default function DeviceKindIcon({ kind, className }: { kind: DeviceKind; className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-kind={kind}
    >
      {PATHS[kind]}
    </svg>
  );
}
