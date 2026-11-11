import { useCallback, useEffect, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const maxPagesRef = useRef(Number(localStorage.getItem("hghub_feed_pages") || "40"));
  const feedKey = useRef(0);

  const refreshFeed = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    setError("");
    try {
      // 随机选取一个起始页，避免每次启动或刷新都展示完全相同的片子
      const maxP = Math.max(1, Math.min(maxPagesRef.current || 40, 100));
      const targetPage = Math.floor(Math.random() * maxP) + 1;
      const res = await api.feed(targetPage, 10);
      const list = res?.items || [];
      if (res?.pagination?.pages) {
        maxPagesRef.current = res.pagination.pages;
        localStorage.setItem("hghub_feed_pages", String(res.pagination.pages));
      }
      // 洗牌打乱当前批次，保证每次首屏第一部片子都不同
      const shuffled = [...list].sort(() => Math.random() - 0.5);
      setItems(shuffled);
      setPage(targetPage);
      setDone(false);
      feedKey.current += 1;
    } catch (e) {
      const message = (e as Error).message || "加载失败";
      setError(message);
      toast(message, "info");
    } finally {
      loadingRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, [toast]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const maxP = Math.max(1, maxPagesRef.current || 40);
      const next = page >= maxP ? 1 : page + 1;
      const res = await api.feed(next, 10);
      const list = res?.items || [];
      if (res?.pagination?.pages) {
        maxPagesRef.current = res.pagination.pages;
        localStorage.setItem("hghub_feed_pages", String(res.pagination.pages));
      }
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...list.filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      if (!list.length) setDone(true);
    } catch (e) {
      const message = (e as Error).message || "加载失败";
      toast(message, "info");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [page, done, toast]);

  useEffect(() => {
    if (!items.length) void refreshFeed();
  }, [items.length, refreshFeed]);

  const ids = items.map((v) => v.id);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed
          key={feedKey.current}
          videoIds={ids}
          mode="home"
          active={active}
          bottomInset={bottomInset}
          onRefresh={refreshFeed}
          refreshing={refreshing}
          onNearEnd={loadMore}
        />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void refreshFeed()} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
