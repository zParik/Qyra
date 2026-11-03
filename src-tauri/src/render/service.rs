//! Tile pool: N below-normal-priority threads rendering display-list regions.
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::oneshot;

use crate::commands::render_worker::RenderWorker;
use crate::error::{AppError, AppResult};
use crate::render::geometry::{page_px, tile_rect, PageSizePt, TileRect};
use crate::render::raster::{render_region, RgbaImage};
use crate::render::scheduler::{Priority, Scheduler};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileReq {
    pub id: u64,
    pub path: String,
    pub page: u32,
    pub scale: f64,
    pub tx: u32,
    pub ty: u32,
    pub priority: Priority,
}

/// What to rasterize once the display list is in hand.
enum Region {
    Tile { tx: u32, ty: u32 },
    WholePage,
}

struct Job {
    path: String,
    page: u32,
    scale: f64,
    region: Region,
    reply: oneshot::Sender<AppResult<Option<RgbaImage>>>,
}

#[derive(Clone)]
pub struct RenderService {
    sched: Arc<Scheduler<Job>>,
    worker: RenderWorker,
}

/// Ids for jobs Rust starts itself (thumbnails, exports) — kept far above the
/// frontend's counter so they never collide.
static INTERNAL_IDS: AtomicU64 = AtomicU64::new(1 << 52);

pub fn internal_id() -> u64 {
    INTERNAL_IDS.fetch_add(1, Ordering::Relaxed)
}

impl RenderService {
    /// Spawn `threads` tile workers. (0 is allowed: jobs then stay queued, which
    /// tests use to exercise cancellation deterministically.)
    pub fn new(worker: RenderWorker, threads: usize) -> Self {
        let sched = Arc::new(Scheduler::new());
        for i in 0..threads {
            let sched = sched.clone();
            let worker = worker.clone();
            std::thread::Builder::new()
                .name(format!("qyra-tile-{i}"))
                .stack_size(16 * 1024 * 1024)
                .spawn(move || {
                    crate::utils::thread_priority::lower_current_thread_priority();
                    while let Some((id, job)) = sched.pop() {
                        // A panic must not kill the thread and shrink the pool for good.
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&worker, &job)))
                            .unwrap_or_else(|_| Err(AppError::Other("render panicked".into())));
                        let stale = sched.finish(id);
                        let _ = job.reply.send(if stale { Ok(None) } else { result });
                    }
                })
                .expect("failed to spawn tile worker");
        }
        Self { sched, worker }
    }

    /// Default pool size: half the cores, 2..=4.
    pub fn default_threads() -> usize {
        (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2) / 2).clamp(2, 4)
    }

    pub fn worker(&self) -> &RenderWorker {
        &self.worker
    }

    /// Queue a job now; the returned future resolves with its result.
    fn submit(
        &self,
        id: u64,
        path: String,
        page: u32,
        scale: f64,
        pri: Priority,
        region: Region,
    ) -> impl Future<Output = AppResult<Option<RgbaImage>>> {
        let (reply, rx) = oneshot::channel();
        let group = path.clone();
        self.sched.push(id, &group, pri, Job { path, page, scale, region, reply });
        async move { rx.await.map_err(|_| AppError::Other("tile worker dropped reply".into()))? }
    }

    /// One tile; await it from async code (no thread held while queued).
    pub fn tile_async(&self, r: TileReq) -> impl Future<Output = AppResult<Option<RgbaImage>>> {
        self.submit(r.id, r.path, r.page, r.scale, r.priority, Region::Tile { tx: r.tx, ty: r.ty })
    }

    /// A whole page; await it from async code.
    pub fn page_async(
        &self,
        id: u64,
        path: String,
        page: u32,
        scale: f64,
        pri: Priority,
    ) -> impl Future<Output = AppResult<Option<RgbaImage>>> {
        self.submit(id, path, page, scale, pri, Region::WholePage)
    }

    /// Blocking form of `tile_async`, for non-async callers.
    pub fn tile(&self, r: TileReq) -> AppResult<Option<RgbaImage>> {
        tauri::async_runtime::block_on(self.tile_async(r))
    }

    /// Blocking form of `page_async`, for non-async callers (thumbnails, export).
    pub fn page(&self, id: u64, path: String, page: u32, scale: f64, pri: Priority) -> AppResult<Option<RgbaImage>> {
        tauri::async_runtime::block_on(self.page_async(id, path, page, scale, pri))
    }

    /// Cancel jobs. Queued ones answer `Ok(None)` right away — cancellation is
    /// never an error; running ones finish and are discarded.
    pub fn cancel(&self, ids: &[u64]) {
        for job in self.sched.cancel(ids) {
            let _ = job.reply.send(Ok(None));
        }
    }

    pub fn cancel_doc(&self, path: &str) {
        for job in self.sched.cancel_group(path) {
            let _ = job.reply.send(Ok(None));
        }
    }
}

fn run(worker: &RenderWorker, job: &Job) -> AppResult<Option<RgbaImage>> {
    let list = worker.display_list(job.path.clone(), job.page)?;
    let b = list.bounds();
    let size = PageSizePt { w: (b.x1 - b.x0) as f64, h: (b.y1 - b.y0) as f64 };
    let px = page_px(size, job.scale);
    let rect = match job.region {
        Region::WholePage => TileRect { x0: 0, y0: 0, x1: px.0, y1: px.1 },
        Region::Tile { tx, ty } => match tile_rect(px, tx, ty) {
            Some(r) => r,
            None => return Ok(None),
        },
    };
    render_region(&list, job.scale, rect).map(Some)
}
