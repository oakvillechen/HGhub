import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type DownloadTask } from "../api";
import { ICheck, IClose, IDownload, IFireF, IFolder } from "../icons";

export type BatchJob = {
  id: string; // `batch_${videoId}`
  videoId: number;
  seriesTitle: string;
  total: number;
  completed: number;
  failed: number;
  currentEp?: number;
  status: "downloading" | "completed" | "cancelled" | "error";
  error?: string;
};

let activeTasks: Record<string, DownloadTask> = {};
let activeBatchJobs: Record<string, BatchJob> = {};
const taskListeners = new Set<(tasks: Record<string, DownloadTask>) => void>();
const batchListeners = new Set<(batches: Record<string, BatchJob>) => void>();

function notifyTasks() {
  const copy = { ...activeTasks };
  taskListeners.forEach((fn) => fn(copy));
}

function notifyBatches() {
  const copy = { ...activeBatchJobs };
  batchListeners.forEach((fn) => fn(copy));
}

export async function triggerDownload(title: string, url: string, id?: string, subDir?: string) {
  const taskId = id || `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const task = await api.downloadVideo(taskId, title, url, subDir);
    activeTasks[taskId] = task;
    notifyTasks();
    return task;
  } catch (e) {
    const err = (e as Error).message || "启动下载失败";
    activeTasks[taskId] = {
      id: taskId,
      title,
      status: "error",
      progress: 0,
      total_segments: 0,
      downloaded_segments: 0,
      error: err,
      sub_dir: subDir,
    };
    notifyTasks();
    throw e;
  }
}

// 批量下载队列控制
const batchCancelFlags = new Set<string>();

export async function triggerBatchDownload(
  videoId: number,
  seriesTitle: string,
  episodes: number[],
) {
  const batchId = `batch_${videoId}`;
  batchCancelFlags.delete(batchId);

  const total = episodes.length;
  const job: BatchJob = {
    id: batchId,
    videoId,
    seriesTitle,
    total,
    completed: 0,
    failed: 0,
    status: "downloading",
    currentEp: episodes[0],
  };

  activeBatchJobs[batchId] = job;
  notifyBatches();

  // 异步执行队列
  (async () => {
    const padLen = total >= 100 ? 3 : total >= 10 ? 2 : 1;

    for (let i = 0; i < episodes.length; i++) {
      if (batchCancelFlags.has(batchId)) {
        job.status = "cancelled";
        notifyBatches();
        return;
      }

      const ep = episodes[i];
      job.currentEp = ep;
      notifyBatches();

      try {
        const info = await api.play(videoId, ep);
        const url = info?.streams?.main || info?.video_url;
        if (!url) throw new Error("未获取到播放地址");

        const epStr = String(ep).padStart(padLen, "0");
        const fileTitle = `${seriesTitle}_第${epStr}集`;
        const taskId = `dl_${videoId}_${ep}`;

        await triggerDownload(fileTitle, url, taskId, seriesTitle);

        // 等待当前集下载完成或取消
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (batchCancelFlags.has(batchId)) {
              clearInterval(checkInterval);
              api.cancelDownload(taskId).catch(() => {});
              resolve();
              return;
            }
            const curTask = activeTasks[taskId];
            if (!curTask || curTask.status === "completed") {
              clearInterval(checkInterval);
              job.completed += 1;
              notifyBatches();
              resolve();
            } else if (curTask.status === "error" || curTask.status === "cancelled") {
              clearInterval(checkInterval);
              job.failed += 1;
              notifyBatches();
              resolve();
            }
          }, 600);
        });
      } catch {
        job.failed += 1;
        notifyBatches();
      }
    }

    if (!batchCancelFlags.has(batchId)) {
      job.status = "completed";
      notifyBatches();
    }
  })();

  return job;
}

export function cancelBatchDownload(batchId: string) {
  batchCancelFlags.add(batchId);
  if (activeBatchJobs[batchId]) {
    activeBatchJobs[batchId].status = "cancelled";
    notifyBatches();
  }
}

export function useDownloadTasks() {
  const [tasks, setTasks] = useState<Record<string, DownloadTask>>({ ...activeTasks });
  const [batches, setBatches] = useState<Record<string, BatchJob>>({ ...activeBatchJobs });

  useEffect(() => {
    taskListeners.add(setTasks);
    batchListeners.add(setBatches);
    return () => {
      taskListeners.delete(setTasks);
      batchListeners.delete(setBatches);
    };
  }, []);

  const isDownloading = useCallback(
    (id: string) => {
      return tasks[id]?.status === "downloading";
    },
    [tasks],
  );

  const isBatchDownloading = useCallback(
    (videoId: number) => {
      return batches[`batch_${videoId}`]?.status === "downloading";
    },
    [batches],
  );

  return { tasks, batches, isDownloading, isBatchDownloading, triggerDownload, triggerBatchDownload, cancelBatchDownload };
}

export function DownloadHost() {
  const [tasks, setTasks] = useState<Record<string, DownloadTask>>({});
  const [batches, setBatches] = useState<Record<string, BatchJob>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = listen<DownloadTask>("download-progress", (event) => {
      const task = event.payload;
      activeTasks[task.id] = task;
      notifyTasks();
    });

    const updateFromActive = (next: Record<string, DownloadTask>) => {
      setTasks(next);
    };
    const updateFromBatches = (next: Record<string, BatchJob>) => {
      setBatches(next);
    };
    taskListeners.add(updateFromActive);
    batchListeners.add(updateFromBatches);

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
      taskListeners.delete(updateFromActive);
      batchListeners.delete(updateFromBatches);
    };
  }, []);

  // 过滤显示项：如果某单集属于正在进行的整部下载，则收敛在全集卡片中展示，不重复弹卡片
  const batchDownloadingSubdirs = new Set(
    Object.values(batches)
      .filter((b) => b.status === "downloading")
      .map((b) => b.seriesTitle),
  );

  const visibleTasks = Object.values(tasks).filter(
    (t) =>
      !dismissed.has(t.id) &&
      (!t.sub_dir || !batchDownloadingSubdirs.has(t.sub_dir)) &&
      (t.status === "downloading" || t.status === "completed" || t.status === "error"),
  );

  const visibleBatches = Object.values(batches).filter(
    (b) => !dismissed.has(b.id) && (b.status === "downloading" || b.status === "completed"),
  );

  if (!visibleTasks.length && !visibleBatches.length) return null;

  const dismissTask = (task: DownloadTask) => {
    if (task.status === "downloading") {
      api.cancelDownload(task.id).catch(() => {});
    }
    setDismissed((prev) => new Set(prev).add(task.id));
  };

  const dismissBatch = (batch: BatchJob) => {
    if (batch.status === "downloading") {
      cancelBatchDownload(batch.id);
    }
    setDismissed((prev) => new Set(prev).add(batch.id));
  };

  return (
    <div
      className="absolute z-[90] flex flex-col gap-2 max-w-sm pointer-events-auto"
      style={{
        bottom: "calc(var(--sab, 0px) + 64px)",
        left: "16px",
        right: "16px",
      }}
    >
      {/* 全集批量下载卡片 */}
      {visibleBatches.map((batch) => {
        const pct = batch.total > 0 ? (batch.completed / batch.total) * 100 : 0;
        return (
          <div
            key={batch.id}
            className="relative overflow-hidden bg-s1/95 border border-primary/20 rounded-2xl p-3.5 shadow-2xl backdrop-blur-xl transition-all ring-1 ring-primary/25"
          >
            {batch.status === "downloading" && (
              <div
                className="absolute inset-0 bg-primary/10 pointer-events-none transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            )}

            <div className="relative flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    batch.status === "completed"
                      ? "bg-mint/20 text-mint"
                      : "bg-primary/20 text-primary animate-pulse"
                  }`}
                >
                  {batch.status === "completed" ? <ICheck size={20} /> : <IDownload size={20} />}
                </span>

                <div className="min-w-0">
                  <div className="text-[13px] font-bold text-on truncate" title={batch.seriesTitle}>
                    {batch.seriesTitle} · 全集
                  </div>
                  <div className="text-[11px] text-mut mt-0.5 truncate">
                    {batch.status === "downloading" ? (
                      <>
                        正在下载第 {batch.currentEp} 集 · 已完成 {batch.completed}/{batch.total} 集 ({pct.toFixed(0)}%)
                      </>
                    ) : (
                      <>全剧共 {batch.total} 集已下载完成！</>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => api.revealDownloadDir(batch.seriesTitle)}
                  title="打开短剧下载文件夹"
                  className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-s3 text-on hover:bg-s4 pressable flex items-center gap-1"
                >
                  <IFolder size={13} />
                  <span>文件夹</span>
                </button>
                <button
                  onClick={() => dismissBatch(batch)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-mut hover:text-on hover:bg-s3 pressable"
                  title={batch.status === "downloading" ? "取消全集下载" : "关闭"}
                >
                  <IClose size={14} />
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* 单集 / 单条视频卡片 */}
      {visibleTasks.map((task) => (
        <div
          key={task.id}
          className="relative overflow-hidden bg-s1/95 border border-white/10 rounded-2xl p-3.5 shadow-2xl backdrop-blur-xl transition-all"
        >
          {task.status === "downloading" && (
            <div
              className="absolute inset-0 bg-primary/10 pointer-events-none transition-all duration-300"
              style={{ width: `${task.progress}%` }}
            />
          )}

          <div className="relative flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                  task.status === "completed"
                    ? "bg-mint/20 text-mint"
                    : task.status === "error"
                      ? "bg-danger/20 text-danger"
                      : "bg-primary/20 text-primary animate-pulse"
                }`}
              >
                {task.status === "completed" ? (
                  <ICheck size={18} />
                ) : task.status === "error" ? (
                  <IFireF size={18} />
                ) : (
                  <IDownload size={18} />
                )}
              </span>

              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-on truncate" title={task.title}>
                  {task.title}
                </div>
                <div className="text-[11px] text-mut mt-0.5 truncate">
                  {task.status === "downloading" && (
                    <>
                      正在下载: {task.progress.toFixed(0)}%
                      {task.total_segments > 0 && ` (${task.downloaded_segments}/${task.total_segments} 分片)`}
                    </>
                  )}
                  {task.status === "completed" && "已完成并保存至本地"}
                  {task.status === "error" && (task.error || "下载失败")}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {task.status === "completed" && task.file_path && (
                <>
                  <button
                    onClick={() => api.openDownloadItem(task.file_path!)}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-primary text-on-primary hover:brightness-110 pressable"
                  >
                    播放
                  </button>
                  <button
                    onClick={() => api.revealDownloadItem(task.file_path!)}
                    title="在访达/文件夹中显示"
                    className="w-7 h-7 rounded-lg bg-s3 flex items-center justify-center text-on hover:bg-s4 pressable"
                  >
                    <IFolder size={14} />
                  </button>
                </>
              )}
              <button
                onClick={() => dismissTask(task)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-mut hover:text-on hover:bg-s3 pressable"
                title={task.status === "downloading" ? "取消下载" : "关闭"}
              >
                <IClose size={14} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
