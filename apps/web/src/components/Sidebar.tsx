"use client";
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, SECTIONS, activeHref } from "../lib/nav";

export function Sidebar({ open, pendingApprovals }: { open: boolean; pendingApprovals?: number }) {
  const pathname = usePathname() ?? "/";
  const active = activeHref(pathname);
  return (
    <aside className={`sidebar${open ? " sidebar--open" : ""}`}>
      <div className="sidebar__brand">
        <div className="sidebar__logo">R</div>
        <div>
          <div className="sidebar__title">RecoverOS</div>
          <div className="sidebar__subtitle">Revenue Recovery OS</div>
        </div>
      </div>
      <nav className="nav">
        {SECTIONS.map((section) => (
          <React.Fragment key={section}>
            <div className="nav__section">{section}</div>
            {NAV_ITEMS.filter((n) => n.section === section).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav__item${active === item.href ? " nav__item--active" : ""}`}
              >
                <span className="nav__icon">{item.icon}</span>
                {item.label}
                {item.href === "/approvals" && pendingApprovals ? (
                  <span className="badge badge--warning">{pendingApprovals}</span>
                ) : null}
              </Link>
            ))}
          </React.Fragment>
        ))}
      </nav>
      <div className="sidebar__footer">Test Mode · seeded data · no real money moves.</div>
    </aside>
  );
}
