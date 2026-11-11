import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, isMobile } from "../api";
import type { Post } from "../types";
import { useStore } from "../store";
import { Empty, Img } from "../components/ui";
import Player from "../components/Player";
import { triggerDownload } from "../components/DownloadManager";
import { IBack, IDownload, IFireF, IPlayF } from "../icons";
import { handleArticleClick, sanitizeHtml } from "../html";

/* ================= 吃瓜列表 ================= */
export function PostsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [items, setItems] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const busy = useRef(false);
  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (busy.current || pageRef.current >= pagesRef.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = pageRef.current + 1;
      const res = await api.posts(next, 20);
      const newItems = res?.items || [];
      const totalPages = res?.pagination?.pages || next;
      pageRef.current = next;
      pagesRef.current = totalPages;
      setPage(next);
      setPages(totalPages);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...newItems.filter((x) => !seen.has(x.id))];
      });
    } catch { /* ignore */ } finally {
      window.setTimeout(() => {
        busy.current = false;
        setLoading(false);
      }, 350);
    }
  }, []);

  useEffect(() => { void loadMore(); }, [loadMore]);
  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinel.current;
    if (!root || !el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es[0]?.isIntersecting && !busy.current && pageRef.current < pagesRef.current) {
          void loadMore();
        }
      },
      { root, rootMargin: "250px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <button onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></button>
        <span className="text-[14px] font-bold text-on">黄果吃瓜</span>
        <span className="text-[10.5px] text-mut ml-1">圈内爆料</span>
      </div>
      <div ref={scrollRef} className="flex-1 scroll-y px-3 pt-3 pb-8">
        {items.length ? (
          <div className={`grid ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"} gap-2`}>
            {items.map((p) => (
              <button key={p.id} onClick={() => push({ kind: "post", id: p.id })}
                className="w-full relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable block"
                style={{ paddingTop: "128%" }}>
                <Img src={p.cover} />
                <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-2">
                  <div className="text-[11.5px] font-medium text-white clamp-2 leading-snug tsh">{p.title}</div>
                  <div className="flex items-center gap-1 mt-1 text-[9.5px] text-white/70">
                    <IFireF size={10} className="text-white/70" />{fmt(p.hot)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : (
          <Empty icon={<IFireF size={26} />} title="暂无吃瓜内容" sub="稍后再来看看" />
        )}
        <div ref={sentinel} className="h-6 pointer-events-none" />
        {loading && <div className="flex justify-center py-2"><div className="w-6 h-6 spinner" /></div>}
        {!loading && page >= pages && items.length > 0 && (
          <div className="text-center text-[10.5px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
    </div>
  );
}

const isHtml = (s: string) => /<(p|div|br|img|h[1-6]|ul|ol|li|blockquote|span|strong|em)\b/i.test(s);

/* ================= 吃瓜详情（网页式浏览） ================= */
export function PostDetail({ id, onBack, active = true }: { id: number; onBack: () => void; active?: boolean }) {
  const { toast, strictSecurity, muted, setMuted } = useStore();
  const [post, setPost] = useState<(Post & { content?: string; video_url?: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [play, setPlay] = useState(false);
  const content = post?.content || "";
  const safeHtml = useMemo(() => sanitizeHtml(content), [content, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };

  useEffect(() => {
    let alive = true;
    api.post(id)
      .then((p) => { if (alive) setPost(p); })
      .catch((e) => { if (alive) setErr((e as Error).message || "加载失败"); });
    return () => { alive = false; };
  }, [id]);

  const onDownload = async () => {
    if (!post?.video_url) return;
    try {
      await triggerDownload(post.title || "吃瓜视频", post.video_url, `dl_post_${post.id}`);
      toast("已开始下载: " + post.title, "ok");
    } catch (e) {
      toast("下载启动失败: " + ((e as Error).message || ""), "info");
    }
  };

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-2 bg-s1" style={{ paddingTop: isMobile ? "var(--sat, 0px)" : 0, height: isMobile ? "calc(44px + var(--sat, 0px))" : 44 }}>
        <button onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={19} /></button>
        <span className="text-[13.5px] font-semibold text-on">吃瓜详情</span>
      </div>

      <div className="flex-1 scroll-y pb-8">
        {err ? (
          <Empty icon={<IFireF size={26} />} title="加载失败" sub={err} />
        ) : !post ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : (
          <>
            <div className="relative w-full bg-black" style={{ height: "min(40vh, 360px)" }}>
              {play && post.video_url ? (
                <Player src={post.video_url} poster={cover(post.cover)} autoPlay active={active} controls muted={muted}
                  onToggleMute={() => setMuted((m) => !m)} diagnosticContext={{ video_id: id, active }} className="w-full h-full" />
              ) : (
                <button onClick={() => { if (post.video_url) setPlay(true); else toast("该帖子没有视频", "info"); }} className="absolute inset-0">
                  <Img src={post.cover} eager />
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center elev-2">
                      <IPlayF size={24} className="text-white ml-0.5" />
                    </span>
                  </span>
                </button>
              )}
            </div>
            <div className="px-4 pt-3.5">
              <h1 className="text-[17px] font-bold text-on leading-snug">{post.title}</h1>
              <div className="flex items-center justify-between gap-2 mt-2">
                <div className="flex items-center gap-2 text-[10.5px] text-mut">
                  <span>{post.publish_time || post.created_at}</span>
                  <span className="flex items-center gap-1"><IFireF size={10} />{fmt(post.hot)}</span>
                </div>
                {post.video_url && (
                  <button onClick={onDownload} className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-s3 hover:bg-s4 text-[11px] font-medium text-on pressable">
                    <IDownload size={13} />
                    <span>下载视频</span>
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {(post.tags || []).slice(0, 8).map((t) => (
                  <span key={t} className="px-2 py-0.5 rounded-(--r-ctl) bg-s3 text-[10.5px] text-on/75">#{t}</span>
                ))}
              </div>
              {post.content && (
                (isHtml(post.content) || (!strictSecurity && /<[a-z][\s\S]*>/i.test(post.content)))
                  ? <div className="article-body mt-3.5" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
                  : <div className="mt-3.5 rounded-(--r-md) bg-s2 p-3.5 text-[12.5px] leading-relaxed text-on/80 whitespace-pre-wrap">{post.content}</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
