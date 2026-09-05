"use client";
import React, { use, useState } from "react";
import Link from "next/link";
import { useApi } from "../../../src/lib/use-api";
import { fetchJson } from "../../../src/lib/client";
import { AsyncBoundary } from "../../../src/components/AsyncBoundary";
import { CaseDetailView } from "../../../src/components/CaseDetailView";
import { useToast } from "../../../src/components/Toast";
import { friendlyError } from "../../../src/lib/errors";
import type { CaseDetailDTO } from "../../../src/lib/types";

export default function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, loading, reload } = useApi<CaseDetailDTO>(`/api/recoveros/cases/${encodeURIComponent(id)}`);
  const toast = useToast();
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    setGenerating(true);
    const { error: apiErr } = await fetchJson(`/api/recoveros/cases/${encodeURIComponent(id)}/recommend`, { method: "POST" });
    setGenerating(false);
    if (apiErr) {
      toast.error("Recommendation failed", friendlyError(apiErr));
    } else {
      toast.success("Gemini recommendation ready", "Advisory only — nothing was executed.");
      reload();
    }
  };

  return (
    <div className="stack gap-16">
      <div className="row gap-8">
        <Link href="/revenue-at-risk" className="link">
          ← Back to Revenue at Risk
        </Link>
      </div>
      <div className="page-head">
        <h1>Recovery Case</h1>
        <p>The full “why money is at risk and how we recover it” view for a single case.</p>
      </div>
      <AsyncBoundary loading={loading} error={error} data={data} onRetry={reload} loadingRows={8}>
        {(detail) => <CaseDetailView detail={detail} onGenerate={generate} generating={generating} />}
      </AsyncBoundary>
    </div>
  );
}
