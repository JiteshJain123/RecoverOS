/** Vertical event timeline (pure). */
import React from "react";

export interface TimelineItem {
  id: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  detail?: React.ReactNode;
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) return <div className="faint">No events recorded.</div>;
  return (
    <div className="timeline">
      {items.map((item, i) => (
        <div className="timeline__item" key={item.id}>
          <div className="timeline__rail">
            <span className="timeline__node" />
            {i < items.length - 1 && <span className="timeline__line" />}
          </div>
          <div className="timeline__body">
            <div className="timeline__title">{item.title}</div>
            {item.meta && <div className="timeline__meta">{item.meta}</div>}
            {item.detail && <div className="mt-8">{item.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
