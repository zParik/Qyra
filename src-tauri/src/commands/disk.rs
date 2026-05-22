use serde::Serialize;
use sysinfo::Disks;
use crate::error::{AppError, AppResult};

#[derive(Serialize)]
pub struct DiskSpace {
    pub total: u64,
    pub available: u64,
    pub used: u64,
}

#[tauri::command]
pub fn get_disk_space() -> AppResult<DiskSpace> {
    let disks = Disks::new_with_refreshed_list();

    // Pick the disk with the largest total space (almost always the primary drive).
    let disk = disks
        .iter()
        .max_by_key(|d| d.total_space())
        .ok_or_else(|| AppError::NotFound("No disks found".to_string()))?;

    let total = disk.total_space();
    let available = disk.available_space();
    let used = total.saturating_sub(available);

    Ok(DiskSpace { total, available, used })
}
