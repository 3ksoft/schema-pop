use wasm_bindgen::prelude::*;
use serde::Serialize;
use object::{Object, ObjectSection};
use gimli::{Reader, EndianSlice, RunTimeEndian};
use std::collections::HashMap;
use std::borrow::Cow;

#[derive(Serialize, Default)]
pub struct DwarfMetadata {
    pub types: HashMap<String, DwarfType>,
}

#[derive(Serialize, Default)]
pub struct DwarfType {
    pub id: String,
    pub tag: String,
    pub name: Option<String>,
    pub byte_size: Option<u64>,
    pub encoding: Option<u64>,
    pub target_type: Option<String>,
    pub array_count: Option<u64>,
    pub fields: Vec<DwarfField>,
}

#[derive(Serialize, Default)]
pub struct DwarfField {
    pub name: Option<String>,
    pub type_id: Option<String>,
    pub offset: Option<u64>,
}

type EndianReader<'a> = EndianSlice<'a, RunTimeEndian>;

fn get_type_offset(attr: gimli::AttributeValue<EndianReader>, unit: &gimli::Unit<EndianReader>) -> Option<String> {
    match attr {
        gimli::AttributeValue::UnitRef(offset) => {
            offset.to_debug_info_offset(&unit.header).map(|o| o.0.to_string())
        }
        gimli::AttributeValue::DebugInfoRef(offset) => {
            Some(offset.0.to_string())
        }
        _ => None,
    }
}

fn get_string(
    dwarf: &gimli::Dwarf<EndianReader>,
    unit: &gimli::Unit<EndianReader>,
    attr: gimli::Attribute<EndianReader>,
) -> Option<String> {
    let r = dwarf.attr_string(unit, attr.value()).ok()?;
    let s = r.to_slice().ok()?;
    Some(String::from_utf8_lossy(&s).into_owned())
}

#[wasm_bindgen]
pub fn extract_metadata(elf_buffer: &[u8]) -> Result<JsValue, JsValue> {
    let file = object::File::parse(elf_buffer)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse ELF: {}", e)))?;

    let endian = if file.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };

    let load_section = |id: gimli::SectionId| -> Result<EndianSlice<RunTimeEndian>, gimli::Error> {
        let data = file
            .section_by_name(id.name())
            .and_then(|s| s.uncompressed_data().ok())
            .unwrap_or(Cow::Borrowed(&[]));
        Ok(EndianSlice::new(Cow::into_owned(data).leak(), endian))
    };

    let dwarf = gimli::Dwarf::load(&load_section)
        .map_err(|e| JsValue::from_str(&format!("Failed to load DWARF: {}", e)))?;

    let mut metadata = DwarfMetadata::default();

    let mut iter = dwarf.units();
    while let Ok(Some(header)) = iter.next() {
        let unit = dwarf.unit(header)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse unit: {}", e)))?;
        let mut entries = unit.entries();

        while let Ok(Some((_, die))) = entries.next_dfs() {
            let tag = die.tag().to_string();
            
            // Only process types we care about
            if !tag.ends_with("_type") { continue; }
            
            let id = if let Some(off) = die.offset().to_debug_info_offset(&unit.header) {
                off.0.to_string()
            } else {
                continue;
            };

            let mut dwarf_type = DwarfType {
                id: id.clone(),
                tag,
                ..Default::default()
            };

            if let Ok(Some(attr)) = die.attr(gimli::DW_AT_name) {
                dwarf_type.name = get_string(&dwarf, &unit, attr);
            }
            if let Ok(Some(attr)) = die.attr(gimli::DW_AT_byte_size) {
                dwarf_type.byte_size = attr.udata_value();
            }
            if let Ok(Some(attr)) = die.attr(gimli::DW_AT_encoding) {
                if let gimli::AttributeValue::Encoding(enc) = attr.value() {
                    dwarf_type.encoding = Some(enc.0 as u64);
                }
            }
            if let Ok(Some(attr)) = die.attr(gimli::DW_AT_type) {
                dwarf_type.target_type = get_type_offset(attr.value(), &unit);
            }

            // Arrays: need to parse subrange to get count
            if dwarf_type.tag == "DW_TAG_array_type" {
                let mut tree = unit.entries_tree(Some(die.offset())).unwrap();
                if let Ok(root) = tree.root() {
                    let mut children = root.children();
                    while let Ok(Some(child)) = children.next() {
                        if child.entry().tag() == gimli::DW_TAG_subrange_type {
                            if let Ok(Some(attr)) = child.entry().attr(gimli::DW_AT_upper_bound) {
                                dwarf_type.array_count = attr.udata_value().map(|v| v + 1);
                            } else if let Ok(Some(attr)) = child.entry().attr(gimli::DW_AT_count) {
                                dwarf_type.array_count = attr.udata_value();
                            }
                        }
                    }
                }
            }

            // Structs: Extract fields
            if dwarf_type.tag == "DW_TAG_structure_type" || dwarf_type.tag == "DW_TAG_union_type" {
                let mut tree = unit.entries_tree(Some(die.offset())).unwrap();
                if let Ok(root) = tree.root() {
                    let mut children = root.children();
                    while let Ok(Some(child)) = children.next() {
                        let child_die = child.entry();
                        if child_die.tag() == gimli::DW_TAG_member {
                            let mut field = DwarfField::default();
                            
                            if let Ok(Some(attr)) = child_die.attr(gimli::DW_AT_name) {
                                field.name = get_string(&dwarf, &unit, attr);
                            }
                            if let Ok(Some(attr)) = child_die.attr(gimli::DW_AT_type) {
                                field.type_id = get_type_offset(attr.value(), &unit);
                            }
                            if let Ok(Some(attr)) = child_die.attr(gimli::DW_AT_data_member_location) {
                                field.offset = attr.udata_value();
                            }
                            
                            dwarf_type.fields.push(field);
                        }
                    }
                }
            }

            metadata.types.insert(id, dwarf_type);
        }
    }

    serde_wasm_bindgen::to_value(&metadata)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}
