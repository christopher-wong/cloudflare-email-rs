export default function Loader({ label = 'loading' }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="label tracking-widest">[{label}]</span>
    </div>
  );
}
