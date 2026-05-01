use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub path: String,
    pub name: String,
    pub starred: bool,
    pub archived: bool,
    pub added_at: i64,
}

pub struct LibraryDb(pub Mutex<Connection>);

pub fn open_db(app: &AppHandle) -> rusqlite::Result<Connection> {
    let dir = app.path().app_data_dir().expect("no app data dir");
    std::fs::create_dir_all(&dir).ok();
    let conn = Connection::open(dir.join("library.db"))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS library (
            path     TEXT    PRIMARY KEY,
            name     TEXT    NOT NULL,
            starred  INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            added_at INTEGER NOT NULL
        );",
    )?;
    Ok(conn)
}

#[tauri::command]
pub fn set_starred(
    db: State<LibraryDb>,
    path: String,
    name: String,
    starred: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO library (path, name, starred, archived, added_at)
         VALUES (?1, ?2, ?3, 0, (strftime('%s','now') * 1000))
         ON CONFLICT(path) DO UPDATE SET name = ?2, starred = ?3",
        params![path, name, starred as i32],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_archived(
    db: State<LibraryDb>,
    path: String,
    name: String,
    archived: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO library (path, name, starred, archived, added_at)
         VALUES (?1, ?2, 0, ?3, (strftime('%s','now') * 1000))
         ON CONFLICT(path) DO UPDATE SET name = ?2, archived = ?3",
        params![path, name, archived as i32],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_starred(db: State<LibraryDb>) -> Result<Vec<LibraryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT path, name, starred, archived, added_at
             FROM library WHERE starred = 1 ORDER BY added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map([], |row| {
            Ok(LibraryEntry {
                path: row.get(0)?,
                name: row.get(1)?,
                starred: row.get::<_, i32>(2)? != 0,
                archived: row.get::<_, i32>(3)? != 0,
                added_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn get_archived(db: State<LibraryDb>) -> Result<Vec<LibraryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT path, name, starred, archived, added_at
             FROM library WHERE archived = 1 ORDER BY added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map([], |row| {
            Ok(LibraryEntry {
                path: row.get(0)?,
                name: row.get(1)?,
                starred: row.get::<_, i32>(2)? != 0,
                archived: row.get::<_, i32>(3)? != 0,
                added_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn get_entry(db: State<LibraryDb>, path: String) -> Result<Option<LibraryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT path, name, starred, archived, added_at
             FROM library WHERE path = ?1",
        )
        .map_err(|e| e.to_string())?;
    let entry = stmt
        .query_row(params![path], |row| {
            Ok(LibraryEntry {
                path: row.get(0)?,
                name: row.get(1)?,
                starred: row.get::<_, i32>(2)? != 0,
                archived: row.get::<_, i32>(3)? != 0,
                added_at: row.get(4)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(entry)
}
