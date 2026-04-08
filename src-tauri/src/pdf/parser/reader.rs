/// `PdfReader` — high-level facade over the parser layer.
use std::collections::{HashMap, HashSet};

use crate::pdf::error::PdfError;
use crate::pdf::parser::object::parse_indirect_object;
use crate::pdf::parser::object_stream::parse_object_stream;
use crate::pdf::parser::xref::parse_xref;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject, XrefEntry, XrefTable};

pub struct PdfReader {
    pub data: Vec<u8>,
    pub xref: XrefTable,
    cache: HashMap<ObjectId, PdfObject>,
    /// Pre-unpacked ObjStm contents: stream_obj_number → vec of (id, object).
    pub objstm_cache: HashMap<u32, Vec<(ObjectId, PdfObject)>>,
    /// Sorted list of all InUse byte offsets — used to bound stream scans to
    /// one object's region so scan_for_endstream never searches the whole file.
    sorted_offsets: Vec<u64>,
}

impl PdfReader {
    pub fn new(data: Vec<u8>) -> Result<Self, PdfError> {
        let xref = parse_xref(&data)?;

        if xref.trailer.get(b"Encrypt").is_some() {
            return Err(PdfError::EncryptedDocument);
        }

        // Build sorted offset list (O(1) next-offset lookup via binary search).
        let mut sorted_offsets: Vec<u64> = xref
            .entries
            .values()
            .filter_map(|e| {
                if let XrefEntry::InUse { offset } = e {
                    Some(*offset)
                } else {
                    None
                }
            })
            .collect();
        sorted_offsets.sort_unstable();
        sorted_offsets.dedup();

        let mut reader = PdfReader {
            data,
            xref,
            cache: HashMap::new(),
            objstm_cache: HashMap::new(),
            sorted_offsets,
        };

        // Eagerly unpack all ObjStm streams once at construction.
        reader.unpack_all_objstms()?;

        Ok(reader)
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    pub fn trailer(&self) -> &PdfDict {
        &self.xref.trailer
    }

    pub fn all_object_ids(&self) -> Vec<ObjectId> {
        self.xref.entries.keys().cloned().collect()
    }

    pub fn get_object(&mut self, id: ObjectId) -> Result<&PdfObject, PdfError> {
        if self.cache.contains_key(&id) {
            return Ok(self.cache.get(&id).unwrap());
        }

        let entry = match self.xref.entries.get(&id) {
            Some(e) => e.clone(),
            None => {
                self.cache.insert(id, PdfObject::Null);
                return Ok(self.cache.get(&id).unwrap());
            }
        };

        match entry {
            XrefEntry::Free => {
                self.cache.insert(id, PdfObject::Null);
            }
            XrefEntry::InUse { offset } => {
                self.load_from_disk(id, offset)?;
            }
            XrefEntry::Compressed { obj_stream_id, index } => {
                self.load_from_objstm(id, obj_stream_id, index)?;
            }
        }

        Ok(self.cache.get(&id).unwrap_or(&PdfObject::Null))
    }

    pub fn catalog(&mut self) -> Result<PdfDict, PdfError> {
        let root_id = self
            .xref
            .trailer
            .get(b"Root")
            .and_then(|v| v.as_reference())
            .ok_or_else(|| PdfError::ParseError("Trailer missing /Root".into()))?;

        let obj = self.get_object(root_id)?.clone();
        match obj {
            PdfObject::Dictionary(d) => Ok(d),
            PdfObject::Stream(s) => Ok(s.dict),
            _ => Err(PdfError::ParseError("/Root is not a dictionary".into())),
        }
    }

    pub fn pages(&mut self) -> Result<Vec<ObjectId>, PdfError> {
        let catalog = self.catalog()?;
        let pages_id = catalog
            .get(b"Pages")
            .and_then(|v| v.as_reference())
            .ok_or_else(|| PdfError::ParseError("Catalog missing /Pages".into()))?;

        let mut result = Vec::new();
        let mut visited = HashSet::new();
        self.collect_pages(pages_id, &mut result, &mut visited)?;
        Ok(result)
    }

    /// Consume the reader and return the parts needed for parallel rewriting.
    /// After this call the reader is gone — no more sequential access needed.
    pub fn into_parts(
        self,
    ) -> (
        Vec<u8>,
        XrefTable,
        HashMap<u32, Vec<(ObjectId, PdfObject)>>,
        Vec<u64>,
    ) {
        (self.data, self.xref, self.objstm_cache, self.sorted_offsets)
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /// Return the byte offset of the first InUse object that starts AFTER
    /// `offset`, or the end of the file.  Used to bound stream scans.
    pub fn next_offset_after(&self, offset: u64) -> usize {
        let idx = self.sorted_offsets.partition_point(|&o| o <= offset);
        self.sorted_offsets
            .get(idx)
            .copied()
            .unwrap_or(self.data.len() as u64) as usize
    }

    fn unpack_all_objstms(&mut self) -> Result<(), PdfError> {
        let stm_ids: Vec<u32> = {
            let mut ids: Vec<u32> = self
                .xref
                .entries
                .values()
                .filter_map(|e| {
                    if let XrefEntry::Compressed { obj_stream_id, .. } = e {
                        Some(*obj_stream_id)
                    } else {
                        None
                    }
                })
                .collect();
            ids.sort_unstable();
            ids.dedup();
            ids
        };

        eprintln!("[compress] unpacking {} ObjStm streams…", stm_ids.len());

        for stm_id in stm_ids {
            if self.objstm_cache.contains_key(&stm_id) {
                continue;
            }

            // Look up the ObjStm's offset in the sorted_offsets is O(log n);
            // use the xref HashMap directly — keyed on (obj_num, gen).
            let stm_offset = match self.xref.entries.get(&(stm_id, 0)) {
                Some(XrefEntry::InUse { offset }) => *offset,
                _ => continue, // not found or not InUse — skip
            };

            // Bound the slice so scan_for_endstream can't escape this object.
            let end = self.next_offset_after(stm_offset);
            let slice = &self.data[stm_offset as usize..end];

            let (_, stm_obj) = match parse_indirect_object(slice, 0) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let stream = match stm_obj {
                PdfObject::Stream(s) => s,
                _ => continue,
            };

            if let Ok(objects) = parse_object_stream(&stream) {
                self.objstm_cache.insert(stm_id, objects);
            }
        }

        Ok(())
    }

    fn load_from_disk(&mut self, id: ObjectId, offset: u64) -> Result<(), PdfError> {
        // Slice to [offset, next_object_offset] so scan_for_endstream is bounded.
        let end = self.next_offset_after(offset);
        let slice = &self.data[offset as usize..end];

        let (parsed_id, obj) = parse_indirect_object(slice, 0).map_err(|e| {
            PdfError::MalformedObject {
                id,
                reason: format!("{}", e),
            }
        })?;

        self.cache.insert(parsed_id, obj.clone());
        if parsed_id != id {
            self.cache.insert(id, obj);
        }
        Ok(())
    }

    fn load_from_objstm(&mut self, id: ObjectId, stm_id: u32, index: u32) -> Result<(), PdfError> {
        let packed = self.objstm_cache.get(&stm_id).ok_or_else(|| {
            PdfError::ParseError(format!("ObjStm {} not in cache", stm_id))
        })?;

        let obj = packed
            .get(index as usize)
            .map(|(_, o)| o.clone())
            .unwrap_or(PdfObject::Null);

        self.cache.insert(id, obj);
        Ok(())
    }

    fn collect_pages(
        &mut self,
        node_id: ObjectId,
        result: &mut Vec<ObjectId>,
        visited: &mut HashSet<ObjectId>,
    ) -> Result<(), PdfError> {
        if !visited.insert(node_id) {
            return Ok(()); // cycle — stop silently
        }

        let obj = self.get_object(node_id)?.clone();
        let dict = match &obj {
            PdfObject::Dictionary(d) => d.clone(),
            PdfObject::Stream(s) => s.dict.clone(),
            _ => return Ok(()),
        };

        let node_type = dict
            .get_type()
            .map(|t| t.to_vec())
            .unwrap_or_else(|| b"Pages".to_vec());

        if node_type == b"Page" {
            result.push(node_id);
        } else {
            let kids = dict
                .get(b"Kids")
                .and_then(|v| v.as_array())
                .map(|a| a.to_vec())
                .unwrap_or_default();

            for kid in kids {
                if let PdfObject::Reference(kid_id) = kid {
                    self.collect_pages(kid_id, result, visited)?;
                }
            }
        }
        Ok(())
    }
}
