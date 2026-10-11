//! Priority queue for render jobs with cancellation.
//!
//! Lower `Priority` runs first; equal priorities run FIFO. A queued job that is
//! cancelled never runs. A job already running when cancelled runs to the end
//! (tiles are small), and `finish` then reports that its result is stale.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::{Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Visible = 0,
    Preview = 1,
    Prefetch = 2,
}

struct Entry<J> {
    pri: Priority,
    seq: u64,
    id: u64,
    group: String,
    job: J,
}

impl<J> PartialEq for Entry<J> {
    fn eq(&self, o: &Self) -> bool {
        self.pri == o.pri && self.seq == o.seq
    }
}
impl<J> Eq for Entry<J> {}
impl<J> PartialOrd for Entry<J> {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl<J> Ord for Entry<J> {
    // BinaryHeap is a max-heap: invert so the lowest (priority, seq) pops first.
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        (o.pri, o.seq).cmp(&(self.pri, self.seq))
    }
}

struct State<J> {
    queue: BinaryHeap<Entry<J>>,
    running: HashMap<u64, String>,
    stale: HashSet<u64>,
    seq: u64,
    shutdown: bool,
}

pub struct Scheduler<J> {
    state: Mutex<State<J>>,
    ready: Condvar,
}

impl<J> Default for Scheduler<J> {
    fn default() -> Self {
        Self::new()
    }
}

impl<J> Scheduler<J> {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                queue: BinaryHeap::new(),
                running: HashMap::new(),
                stale: HashSet::new(),
                seq: 0,
                shutdown: false,
            }),
            ready: Condvar::new(),
        }
    }

    pub fn push(&self, id: u64, group: &str, pri: Priority, job: J) {
        let mut s = self.state.lock().unwrap();
        s.seq += 1;
        let seq = s.seq;
        s.queue.push(Entry { pri, seq, id, group: group.to_string(), job });
        drop(s);
        self.ready.notify_one();
    }

    /// Block until a job is available; `None` once shut down.
    pub fn pop(&self) -> Option<(u64, J)> {
        let mut s = self.state.lock().unwrap();
        loop {
            if s.shutdown {
                return None;
            }
            if let Some(e) = s.queue.pop() {
                s.running.insert(e.id, e.group);
                return Some((e.id, e.job));
            }
            s = self.ready.wait(s).unwrap();
        }
    }

    /// Mark `id` done. Returns true when it was cancelled while running.
    pub fn finish(&self, id: u64) -> bool {
        let mut s = self.state.lock().unwrap();
        s.running.remove(&id);
        s.stale.remove(&id)
    }

    pub fn cancel(&self, ids: &[u64]) {
        let mut s = self.state.lock().unwrap();
        let ids: HashSet<u64> = ids.iter().copied().collect();
        s.queue.retain(|e| !ids.contains(&e.id));
        let running: Vec<u64> = s.running.keys().copied().filter(|id| ids.contains(id)).collect();
        s.stale.extend(running);
    }

    pub fn cancel_group(&self, group: &str) {
        let mut s = self.state.lock().unwrap();
        s.queue.retain(|e| e.group != group);
        let running: Vec<u64> =
            s.running.iter().filter(|(_, g)| g.as_str() == group).map(|(id, _)| *id).collect();
        s.stale.extend(running);
    }

    pub fn shutdown(&self) {
        self.state.lock().unwrap().shutdown = true;
        self.ready.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_priority_first_then_fifo() {
        let s = Scheduler::new();
        s.push(1, "a", Priority::Prefetch, "p1");
        s.push(2, "a", Priority::Visible, "v1");
        s.push(3, "a", Priority::Visible, "v2");
        s.push(4, "a", Priority::Preview, "r1");
        let order: Vec<_> = (0..4).map(|_| s.pop().unwrap().1).collect();
        assert_eq!(order, vec!["v1", "v2", "r1", "p1"]);
    }

    #[test]
    fn cancelled_queued_job_never_runs() {
        let s = Scheduler::new();
        s.push(1, "a", Priority::Visible, "x");
        s.push(2, "a", Priority::Visible, "y");
        s.cancel(&[1]);
        assert_eq!(s.pop().unwrap(), (2, "y"));
    }

    #[test]
    fn cancelling_a_running_job_marks_its_result_stale() {
        let s = Scheduler::new();
        s.push(7, "a", Priority::Visible, ());
        let (id, ()) = s.pop().unwrap();
        s.cancel(&[id]);
        assert!(s.finish(id), "result must be discarded");
        assert!(!s.finish(id), "flag is consumed");
    }

    #[test]
    fn finished_job_not_cancelled_is_kept() {
        let s = Scheduler::new();
        s.push(1, "a", Priority::Visible, ());
        let (id, ()) = s.pop().unwrap();
        assert!(!s.finish(id));
    }

    #[test]
    fn cancel_group_drops_queued_and_marks_running() {
        let s = Scheduler::new();
        s.push(1, "doc-a", Priority::Visible, 1);
        let (running, _) = s.pop().unwrap();
        s.push(2, "doc-a", Priority::Visible, 2);
        s.push(3, "doc-b", Priority::Visible, 3);
        s.cancel_group("doc-a");
        assert!(s.finish(running));
        assert_eq!(s.pop().unwrap(), (3, 3));
    }

    #[test]
    fn pop_returns_none_after_shutdown() {
        let s: Scheduler<()> = Scheduler::new();
        s.shutdown();
        assert!(s.pop().is_none());
    }
}
