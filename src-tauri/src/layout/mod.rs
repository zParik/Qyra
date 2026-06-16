//! Native document layout: turn a parsed [`crate::oxml::model::Document`] into a
//! positioned box tree (`engine`) and rasterize it to pixels (`render`), using a
//! single vendored font for measurement (`font`).
//!
//! P1 covers one font, one column, greedy line-breaking, and pagination. The
//! fidelity ladder (run formatting faces, tabs, lists, tables, floats) widens in
//! later phases — see the office-engine design spec.

pub mod engine;
pub mod font;
pub mod render;
