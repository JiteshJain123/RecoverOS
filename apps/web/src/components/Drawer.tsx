"use client";
/** Slide-over drawer + confirmation dialog (client). */
import React, { useEffect } from "react";

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer__head">
          <h3 className="card__title">{title}</h3>
          <button className="btn btn--ghost btn--sm" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer__body">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={busy ? undefined : onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <div className="dialog__title">{title}</div>
        {description && <div className="dialog__desc">{description}</div>}
        <div className="dialog__actions">
          <button className="btn" onClick={onCancel} disabled={busy} type="button">
            {cancelLabel}
          </button>
          <button
            className={`btn ${destructive ? "btn--danger" : "btn--primary"}`}
            onClick={onConfirm}
            disabled={busy}
            type="button"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
