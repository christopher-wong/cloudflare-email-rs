import { ReactNode } from 'react';

/**
 * Sticky topbar inside a scroll-pane (Inbox/Thread/etc.). 56px tall,
 * hairline border below, page title slot on the left, primary actions on
 * the right. Designed to slot beneath the global app Topbar when a route
 * needs its own scroll-local toolbar; otherwise prefer rendering chrome
 * via the parent <Topbar> in Chrome.
 */
export default function Toolbar({
  children,
  right,
}: {
  children?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-bg/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </div>
  );
}
