import { Link } from 'react-router-dom';
import EmptyState from '@/components/EmptyState';

function NotFoundIcon() {
  return (
    <span
      className="text-[22px] font-semibold text-ink-faint leading-none select-none"
      aria-hidden="true"
    >
      ø
    </span>
  );
}

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <EmptyState
        title="Page not found"
        hint="The page you're looking for doesn't exist or has been moved."
        icon={<NotFoundIcon />}
        action={
          <Link to="/" className="btn btn-primary">
            Back to inbox
          </Link>
        }
      />
    </div>
  );
}
