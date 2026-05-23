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
  return (
    <div className="hair-b flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">{children}</div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );
}
