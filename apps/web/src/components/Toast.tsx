"use client";
/** Minimal toast/notification system consistent with the existing stack (no deps). */
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export type ToastKind = "info" | "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}
interface ToastApi {
  push: (t: Omit<Toast, "id">) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { ...t, id }]);
      setTimeout(() => remove(id), 5000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, message) => push({ kind: "success", title, message }),
      error: (title, message) => push({ kind: "error", title, message }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`} role="status" onClick={() => remove(t.id)}>
            <div className="toast__title">{t.title}</div>
            {t.message && <div className="toast__msg">{t.message}</div>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
