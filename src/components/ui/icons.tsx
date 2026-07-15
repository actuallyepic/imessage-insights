type IconProps = {
  /** Stroke/fill colour. Defaults to currentColor so nav can tint via text colour. */
  color?: string;
  size?: number;
};

export function OverviewIcon({ color = "currentColor", size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1" y="1" width="6" height="6" rx="1.5" fill={color} />
      <rect x="9" y="1" width="6" height="6" rx="1.5" fill={color} opacity="0.55" />
      <rect x="1" y="9" width="6" height="6" rx="1.5" fill={color} opacity="0.55" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" fill={color} />
    </svg>
  );
}

export function MessagesIcon({ color = "currentColor", size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="9" rx="3" stroke={color} strokeWidth="1.4" />
      <path d="M5 11.5v2.2L8 11.5" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function CallsIcon({ color = "currentColor", size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3.5c0 5 4.5 9.5 9.5 9.5l0-2.6-2.7-.9-1.3 1.3a8 8 0 0 1-3.3-3.3l1.3-1.3-.9-2.7L3 3.5Z"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PeopleIcon({ color = "currentColor", size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="6" cy="5.5" r="2.4" stroke={color} strokeWidth="1.3" />
      <circle cx="11" cy="6.5" r="1.8" stroke={color} strokeWidth="1.3" />
      <path d="M2 13.5c0-2.2 1.8-3.7 4-3.7s4 1.5 4 3.7" stroke={color} strokeWidth="1.3" />
    </svg>
  );
}

export function ReportsIcon({ color = "currentColor", size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="1.5" width="10" height="13" rx="2" stroke={color} strokeWidth="1.3" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function RefreshIcon({ color = "currentColor", size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon({ color = "currentColor", size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke={color} strokeWidth="1.4" />
      <path d="M11 11l3 3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ShareIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3a1 1 0 0 1 1 1v8.586l1.293-1.293a1 1 0 0 1 1.414 1.414l-3.004 3.004a1 1 0 0 1-1.414 0L8.285 12.707a1 1 0 0 1 1.414-1.414L11 12.586V4a1 1 0 0 1 1-1m-7 10a1 1 0 0 1 1 1v4h12v-4a1 1 0 0 1 2 0v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1" />
    </svg>
  );
}

export function Spinner({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="animate-spin" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
