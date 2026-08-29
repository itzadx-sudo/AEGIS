import { cn } from "@/lib/utils";
export function PageHeader({ title, subtitle, titleClassName }) {
  return (
    <header>
       <h1
        className={cn(
          "mb-1.5 font-mono text-[28px] font-bold tracking-[-0.02em] text-white",
          titleClassName
        )}
      >
        {title}
      </h1>
      <p className="mb-8 text-[13.5px] text-ink-dim">{subtitle}</p>
    </header>
  );
}

export function PageShell({ children }) {
  return (
    <main className="mx-auto w-full max-w-[1650px] flex-1 px-16 pb-24 pt-[56px]">
      {children}
    </main>
  );
}
