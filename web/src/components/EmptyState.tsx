import { ReactNode } from 'react';

/**
 * Empty state per design system: 56×56 icon disc, headline, one-line
 * explainer, optional action. No illustrations.
 */
export default function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full border border-border bg-elev text-ink-muted">
        {icon ?? <DefaultIcon />}
      </div>
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      {hint && <div className="max-w-[40ch] text-[13.5px] text-ink-muted">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

function DefaultIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 13l3-8h12l3 8" />
      <path d="M3 13h5l1 3h6l1-3h5v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z" />
    </svg>
  );
}
