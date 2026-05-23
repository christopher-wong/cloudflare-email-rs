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
  return (
    <div className="hair-b sticky top-0 z-10 flex items-center justify-between bg-white px-3 py-2">
      <div className="flex items-center gap-2">{children}</div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );
}
