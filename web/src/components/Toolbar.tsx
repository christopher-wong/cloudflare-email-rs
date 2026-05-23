/**
 * A toolbar — a row of square buttons separated by hairlines. Used at the
 * top of inbox/thread/compose. Each child should be a <button class="btn">.
 */

import { ReactNode } from 'react';

export default function Toolbar({
  children,
  right,
}: {
  children?: ReactNode;
  right?: ReactNode;
}) {
  // sticky so the toolbar pins to the top of whichever scroll container
  // owns it (Inbox/Sent/Drafts lists, Thread message list, etc.). bg-white
  // is required — without it the scrolling content shows through. z-10
  // keeps it above message rows on hover/active states.
  // Two flex groups separated by justify-between:
  //   left = `children`  (page title + inline controls — search, filters, etc.)
  //   right = `right`    (primary action — compose, delete, etc.)
  // The left group has `min-w-0` so it can shrink under pressure (long search
  // inputs, long titles, etc.) instead of pushing past the parent's width and
  // forcing a horizontal scroll on the whole page. The right group is
  // `shrink-0` so the primary action never gets clipped off-screen — at very
  // narrow widths the left controls should compress / hide, not the CTA.
  // `overflow-hidden` is a safety net for either group going wrong.
  return (
    <div className="hair-b sticky top-0 z-10 flex items-center justify-between gap-2 overflow-hidden bg-white px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </div>
  );
}
