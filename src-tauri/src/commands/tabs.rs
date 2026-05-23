use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

use super::library::LibraryDb;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabEntry {
    pub path: String,
    pub name: String,
}

fn lock(db: &State<LibraryDb>) -> AppResult<std::sync::MutexGuard<Connection>> {
    db.0.lock().map_err(|e| AppError::Lock(e.to_string()))
}

/// Load persisted tab session. Returns tabs ordered by position.
#[tauri::command]
pub fn get_tab_session(db: State<LibraryDb>) -> AppResult<(Vec<TabEntry>, i32)> {
    let conn = lock(&db)?;
    let mut stmt = conn.prepare(
        "SELECT path, name, is_active FROM open_tabs ORDER BY position ASC",
    )?;
    let mut tabs = Vec::new();
    let mut active: i32 = 0;
    let rows = stmt.query_map([], |r| {
        Ok((
            TabEntry { path: r.get(0)?, name: r.get(1)? },
            r.get::<_, i32>(2)?,
        ))
    })?;
    for (i, row) in rows.enumerate() {
        let (entry, is_active) = row?;
        if is_active != 0 {
            active = i as i32;
        }
        tabs.push(entry);
    }
    Ok((tabs, active))
}

/// Persist the full tab list and which index is active.
#[tauri::command]
pub fn save_tab_session(
    db: State<LibraryDb>,
    tabs: Vec<TabEntry>,
    active_index: i32,
) -> AppResult<()> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM open_tabs", [])?;
    for (i, tab) in tabs.iter().enumerate() {
        let is_active = if i as i32 == active_index { 1 } else { 0 };
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (?1, ?2, ?3, ?4)",
            params![i as i32, tab.path, tab.name, is_active],
        )?;
    }
    Ok(())
}

/// Upsert per-file page position and zoom.
#[tauri::command]
pub fn save_tab_ui_state(
    db: State<LibraryDb>,
    path: String,
    current_page: i32,
    zoom: f64,
) -> AppResult<()> {
    let conn = lock(&db)?;
    conn.execute(
        "INSERT INTO tab_ui_state (path, current_page, zoom, updated_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))
         ON CONFLICT(path) DO UPDATE SET
           current_page = excluded.current_page,
           zoom         = excluded.zoom,
           updated_at   = excluded.updated_at",
        params![path, current_page, zoom],
    )?;
    Ok(())
}

/// Read saved page + zoom for a single path. Returns (1, 1.0) if not found.
#[tauri::command]
pub fn get_tab_ui_state(db: State<LibraryDb>, path: String) -> AppResult<(i32, f64)> {
    let conn = lock(&db)?;
    let result = conn.query_row(
        "SELECT current_page, zoom FROM tab_ui_state WHERE path = ?1",
        params![path],
        |r| Ok((r.get::<_, i32>(0)?, r.get::<_, f64>(1)?)),
    );
    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok((1, 1.0)),
        Err(e) => Err(e.into()),
    }
}

/// Remove all open_tabs rows.
#[tauri::command]
pub fn clear_tab_session(db: State<LibraryDb>) -> AppResult<()> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM open_tabs", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            CREATE TABLE open_tabs (
                position INTEGER NOT NULL,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tab_ui_state (
                path TEXT PRIMARY KEY,
                current_page INTEGER NOT NULL DEFAULT 1,
                zoom REAL NOT NULL DEFAULT 1.0,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
        ").unwrap();
        conn
    }

    #[test]
    fn save_and_load_session() {
        let conn = setup();
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (0, '/a.pdf', 'a.pdf', 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (1, '/b.pdf', 'b.pdf', 1)",
            [],
        ).unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, name, is_active FROM open_tabs ORDER BY position ASC",
        ).unwrap();
        let rows: Vec<(String, String, i32)> = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        }).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "/a.pdf");
        assert_eq!(rows[1].2, 1);
    }

    #[test]
    fn upsert_tab_ui_state() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tab_ui_state (path, current_page, zoom, updated_at)
             VALUES ('/a.pdf', 5, 1.5, strftime('%s','now'))
             ON CONFLICT(path) DO UPDATE SET
               current_page = excluded.current_page,
               zoom = excluded.zoom,
               updated_at = excluded.updated_at",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO tab_ui_state (path, current_page, zoom, updated_at)
             VALUES ('/a.pdf', 10, 2.0, strftime('%s','now'))
             ON CONFLICT(path) DO UPDATE SET
               current_page = excluded.current_page,
               zoom = excluded.zoom,
               updated_at = excluded.updated_at",
            [],
        ).unwrap();
        let (page, zoom): (i32, f64) = conn.query_row(
            "SELECT current_page, zoom FROM tab_ui_state WHERE path = '/a.pdf'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(page, 10);
        assert!((zoom - 2.0).abs() < 0.001);
    }

    #[test]
    fn clear_session() {
        let conn = setup();
        conn.execute(
            "INSERT INTO open_tabs (position, path, name, is_active) VALUES (0, '/a.pdf', 'a.pdf', 1)",
            [],
        ).unwrap();
        conn.execute("DELETE FROM open_tabs", []).unwrap();
        let count: i32 = conn.query_row("SELECT COUNT(*) FROM open_tabs", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
