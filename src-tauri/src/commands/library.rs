use crate::error::{AppError, AppResult};
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

const DB_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS library (
        path     TEXT    PRIMARY KEY,
        name     TEXT    NOT NULL,
        starred  INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );";

pub fn open_db(app: &AppHandle) -> AppResult<Connection> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("no app data dir: {e}")))?;
    std::fs::create_dir_all(&dir).ok();
    let conn = Connection::open(dir.join("library.db"))?;
    conn.execute_batch(DB_SCHEMA)?;
    Ok(conn)
}

pub fn open_db_in_memory() -> AppResult<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(DB_SCHEMA)?;
    Ok(conn)
}

#[tauri::command]
pub fn get_setting(db: State<LibraryDb>, key: String) -> AppResult<Option<String>> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    let val = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?;
    Ok(val)
}

#[tauri::command]
pub fn set_setting(db: State<LibraryDb>, key: String, value: String) -> AppResult<()> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_starred(
    db: State<LibraryDb>,
    path: String,
    name: String,
    starred: bool,
) -> AppResult<()> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    conn.execute(
        "INSERT INTO library (path, name, starred, archived, added_at)
         VALUES (?1, ?2, ?3, 0, (strftime('%s','now') * 1000))
         ON CONFLICT(path) DO UPDATE SET name = ?2, starred = ?3",
        params![path, name, starred as i32],
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_archived(
    db: State<LibraryDb>,
    path: String,
    name: String,
    archived: bool,
) -> AppResult<()> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    conn.execute(
        "INSERT INTO library (path, name, starred, archived, added_at)
         VALUES (?1, ?2, 0, ?3, (strftime('%s','now') * 1000))
         ON CONFLICT(path) DO UPDATE SET name = ?2, archived = ?3",
        params![path, name, archived as i32],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_starred(db: State<LibraryDb>) -> AppResult<Vec<LibraryEntry>> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT path, name, starred, archived, added_at
         FROM library WHERE starred = 1 ORDER BY added_at DESC",
    )?;
    let entries = stmt
        .query_map([], |row| {
            Ok(LibraryEntry {
                path: row.get(0)?,
                name: row.get(1)?,
                starred: row.get::<_, i32>(2)? != 0,
                archived: row.get::<_, i32>(3)? != 0,
                added_at: row.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn get_archived(db: State<LibraryDb>) -> AppResult<Vec<LibraryEntry>> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT path, name, starred, archived, added_at
         FROM library WHERE archived = 1 ORDER BY added_at DESC",
    )?;
    let entries = stmt
        .query_map([], |row| {
            Ok(LibraryEntry {
                path: row.get(0)?,
                name: row.get(1)?,
                starred: row.get::<_, i32>(2)? != 0,
                archived: row.get::<_, i32>(3)? != 0,
                added_at: row.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn get_entry(db: State<LibraryDb>, path: String) -> AppResult<Option<LibraryEntry>> {
    let conn = db.0.lock().map_err(|e| AppError::Lock(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT path, name, starred, archived, added_at
         FROM library WHERE path = ?1",
    )?;
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
        .optional()?;
    Ok(entry)
}
