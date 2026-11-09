import React from "react";
import { cover, fmt } from "../api";
import type { VideoCard } from "../types";
import { IHeartF, IPlayF } from "../icons";
import { Img } from "./ui";

/* ——— 瀑布流卡片 ——— */
export function WaterfallCard({ v, onOpen, eager = false }: { v: VideoCard; onOpen: () => void; eager?: boolean }) {
  const ratio = 1.32;
  return (
    <button onClick={onOpen}
      className="relative w-full overflow-hidden text-left bg-s1 elev-1 pressable block rounded-(--r-sm)"
      style={{ paddingTop: `${ratio * 100}%` }}>
      <Img src={v.cover} eager={eager} />
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold brand-grad elev-1">
        {v.is_finished ? "已完结" : `更新至${v.episode_count}集`}
      </span>
      <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/45 backdrop-blur-sm text-[9px] font-semibold text-white/90">
        <IPlayF size={9} />{fmt(v.hot)}
      </span>
      <div className="absolute inset-x-0 bottom-0 p-2">
        <div className="text-[11.5px] font-medium text-white leading-snug clamp-2 tsh">{v.title}</div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[9.5px] text-white/65 truncate max-w-[60%]">{v.author?.name || "黄果短剧"}</span>
          <span className="flex items-center gap-0.5 text-[9.5px] text-white/75"><IHeartF size={10} className="text-white/70" />{fmt(v.like_count)}</span>
        </div>
      </div>
    </button>
  );
}

/* ——— 近无缝瀑布流 ——— */
export function Masonry({ videos, onOpen, wide = false, gap = "gap-2" }: {
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string;
}) {
  return (
    <div className={`grid ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"} ${gap}`}>
      {videos.map((v, idx) => (
        <div key={v.id}>
          <WaterfallCard v={v} onOpen={() => onOpen(v)} eager={idx < 12} />
        </div>
      ))}
    </div>
  );
}

/* ——— 分类横向卡片 ——— */
export function RowCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="w-[104px] shrink-0 text-left snap-start pressable group">
      <div className="relative w-full rounded-(--r-sm) overflow-hidden bg-s1 elev-1" style={{ paddingTop: "133%" }}>
        <Img src={v.cover} />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" />
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[8.5px] font-bold brand-grad">
          {v.is_finished ? "完结" : `${v.episode_count}集`}
        </span>
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[9px] font-semibold text-white/90 tsh"><IPlayF size={9} />{fmt(v.hot)}</span>
      </div>
      <div className="mt-1.5 text-[11.5px] font-medium text-on clamp-1 leading-tight">{v.title}</div>
      <div className="text-[10px] text-mut clamp-1 mt-0.5">{v.tags?.slice(0, 2).join(" · ")}</div>
    </button>
  );
}

/* ——— 排行榜条目 ——— */
export function RankRow({ item, onOpen, metricMax }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string };
  onOpen: () => void; metricMax: number;
}) {
  const i = item.rank - 1;
  return (
    <button onClick={onOpen}
      className={`w-full flex items-center gap-3 p-2.5 rounded-(--r-md) text-left mb-2 pressable a-rise ${i < 3 ? "bg-s3" : "bg-s2"}`}
      style={{ animationDelay: `${Math.min(i * 35, 300)}ms` }}>
      <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 tabular-nums ${i === 0 ? "bg-primary text-on-primary" : i < 3 ? "tonal" : "text-dim"}`}>{item.rank}</span>
      <div className="relative w-[52px] h-[68px] rounded-lg overflow-hidden bg-s3 shrink-0">
        <Img src={item.cover} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-on clamp-2 leading-snug">{item.title}</div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] text-mut truncate">{item.tags?.slice(0, 2).join(" · ")}</span>
          <span className="flex items-center gap-0.5 text-[10px] font-bold text-primary">{fmt(item.metric_value)}</span>
        </div>
        <div className="mt-1.5 h-[3px] rounded-full bg-s4 overflow-hidden">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(6, Math.round((item.metric_value / Math.max(1, metricMax)) * 100))}%` }} />
        </div>
      </div>
    </button>
  );
}