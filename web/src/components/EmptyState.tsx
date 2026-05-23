import { ReactNode } from 'react';

export default function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="label">{title}</div>
      {hint && <div className="text-mute text-sm">{hint}</div>}
      {action}
    </div>
  );
}
