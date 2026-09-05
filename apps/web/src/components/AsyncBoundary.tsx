"use client";
/** Standard loading / error / empty / content switch for a fetched section. */
import React from "react";
import type { ApiError } from "../lib/types";
import { LoadingBlock, ErrorState } from "./primitives";
import { errorTitle, friendlyError } from "../lib/errors";

export function AsyncBoundary<T>({
  loading,
  error,
  data,
  onRetry,
  isEmpty,
  empty,
  loadingRows = 5,
  children,
}: {
  loading: boolean;
  error: ApiError | null;
  data: T | null;
  onRetry?: () => void;
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  loadingRows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (loading && !data) return <LoadingBlock rows={loadingRows} />;
  if (error) return <ErrorState title={errorTitle(error)} desc={friendlyError(error)} onRetry={onRetry} />;
  if (!data) return <ErrorState title="No data" desc="The server returned an empty response." onRetry={onRetry} />;
  if (isEmpty && isEmpty(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}
