import type { ReactNode } from "react";

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

export type Mark = "yes" | "no" | "warn" | "info";
const glyph: Record<Mark, string> = { yes: "✓", no: "–", warn: "!", info: "i" };
export function Indicator({ mark, label }: { mark: Mark; label?: string }) {
  return <span className={`indicator ${mark}`} aria-label={label ?? mark}>{glyph[mark]}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><dt>{label}</dt><dd>{children}</dd></div>;
}
