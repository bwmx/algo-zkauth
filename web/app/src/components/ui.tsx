import { useState, type ReactNode } from "react";

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

export function Copy({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="link-button" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
    }}>{copied ? "Copied" : label}</button>
  );
}

export type Mark = "yes" | "no" | "warn" | "info";
const glyph: Record<Mark, string> = { yes: "✓", no: "–", warn: "!", info: "i" };
export function Indicator({ mark, label }: { mark: Mark; label?: string }) {
  return <span className={`indicator ${mark}`} aria-label={label ?? mark}>{glyph[mark]}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><dt>{label}</dt><dd>{children}</dd></div>;
}

export const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;
