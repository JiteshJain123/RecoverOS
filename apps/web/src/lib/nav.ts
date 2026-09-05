/** Central navigation definition for the Control Room shell. */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  section: "Operate" | "Analyze" | "Configure";
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: "◆", section: "Operate" },
  { href: "/revenue-at-risk", label: "Revenue at Risk", icon: "⚠", section: "Operate" },
  { href: "/recovery-queue", label: "Recovery Queue", icon: "☰", section: "Operate" },
  { href: "/approvals", label: "Approvals", icon: "✔", section: "Operate" },
  { href: "/evaluations", label: "Evaluations", icon: "▤", section: "Analyze" },
  { href: "/failure-lab", label: "Failure Lab", icon: "⚗", section: "Analyze" },
  { href: "/audit-log", label: "Audit Log", icon: "❐", section: "Analyze" },
  { href: "/integration", label: "Integration", icon: "⇄", section: "Configure" },
  { href: "/settings", label: "Settings", icon: "⚙", section: "Configure" },
];

export const SECTIONS: ReadonlyArray<NavItem["section"]> = ["Operate", "Analyze", "Configure"];

/** Match the active nav item for a pathname (longest-prefix, root exact). */
export function activeHref(pathname: string): string {
  if (pathname === "/") return "/";
  const match = NAV_ITEMS.filter((n) => n.href !== "/")
    .filter((n) => pathname === n.href || pathname.startsWith(n.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0];
  // Case detail lives under /cases/* — highlight Revenue at Risk.
  if (!match && pathname.startsWith("/cases")) return "/revenue-at-risk";
  return match?.href ?? "/";
}

/** Human title for the current route (for the header). */
export function titleFor(pathname: string): string {
  if (pathname.startsWith("/cases/")) return "Recovery Case";
  const item = NAV_ITEMS.find((n) => n.href === activeHref(pathname));
  return item?.label ?? "RecoverOS";
}
