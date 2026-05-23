import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <div className="label">404</div>
      <Link to="/" className="btn label">back to inbox</Link>
    </div>
  );
}
