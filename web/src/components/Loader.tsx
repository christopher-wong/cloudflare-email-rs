export default function Loader({ label = 'loading' }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-ink-faint">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse-soft" />
        <span className="text-[12px] uppercase tracking-widest">{label}</span>
      </div>
    </div>
  );
}
