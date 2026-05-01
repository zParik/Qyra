use serde::Serialize;
use sysinfo::Disks;

#[derive(Serialize)]
pub struct DiskSpace {
    pub total: u64,
    pub available: u64,
    pub used: u64,
}

#[tauri::command]
pub fn get_disk_space() -> Result<DiskSpace, String> {
    let disks = Disks::new_with_refreshed_list();

    // Pick the disk with the largest total space (almost always the primary drive).
    let disk = disks
        .iter()
        .max_by_key(|d| d.total_space())
        .ok_or_else(|| "No disks found".to_string())?;

    let total = disk.total_space();
    let available = disk.available_space();
    let used = total.saturating_sub(available);

    Ok(DiskSpace { total, available, used })
}
