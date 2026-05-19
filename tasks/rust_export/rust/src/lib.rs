#![allow(dead_code, unused_imports, non_camel_case_types, non_snake_case)]

use core::ops::{Deref, DerefMut};
use core::fmt;

/// Bounded UTF-8 string carried inline.
/// Wire format: `[len: u32][data: u8; N]`.
/// no_std compatible — does not pull in `alloc` or `std`.
#[repr(C)]
pub struct SharedString<const N: usize> {
	pub len: u32,
	pub data: [u8; N],
}

impl<const N: usize> SharedString<N> {
	pub const fn new() -> Self { Self { len: 0, data: [0; N] } }
	pub fn from_str(s: &str) -> Self {
		let mut res = Self::new();
		let bytes = s.as_bytes();
		let len = bytes.len().min(N);
		res.data[..len].copy_from_slice(&bytes[..len]);
		res.len = len as u32;
		res
	}
	#[inline] pub fn as_str(&self) -> &str {
		let len = (self.len as usize).min(N);
		core::str::from_utf8(&self.data[..len]).unwrap_or("")
	}
	#[inline] pub fn is_empty(&self) -> bool { self.len == 0 }
	#[inline] pub fn capacity() -> usize { N }
}

impl<const N: usize> Default for SharedString<N> { fn default() -> Self { Self::new() } }
impl<const N: usize> Clone for SharedString<N> { fn clone(&self) -> Self { *self } }
impl<const N: usize> Copy for SharedString<N> {}
impl<const N: usize> PartialEq for SharedString<N> { fn eq(&self, other: &Self) -> bool { self.as_str() == other.as_str() } }
impl<const N: usize> fmt::Debug for SharedString<N> { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{:?}", self.as_str()) } }
impl<const N: usize> Deref for SharedString<N> { type Target = str; fn deref(&self) -> &str { self.as_str() } }
impl<const N: usize> From<&str> for SharedString<N> { fn from(s: &str) -> Self { Self::from_str(s) } }
impl<const N: usize, const M: usize> From<&SharedString<M>> for SharedString<N> {
	fn from(other: &SharedString<M>) -> Self { Self::from_str(other.as_str()) }
}

/// Bounded array of T carried inline.
/// Wire format: `[len: u32][data: T; N]`. Layout matches the analyzer
/// exactly, including any padding Rust inserts between `len` and `data`
/// for alignment of T.
#[repr(C)]
pub struct SharedVec<T, const N: usize> {
	pub len: u32,
	pub data: [T; N],
}

impl<T: Copy + Default, const N: usize> SharedVec<T, N> {
	pub fn new() -> Self { Self { len: 0, data: [T::default(); N] } }
	pub fn push(&mut self, item: T) -> core::result::Result<(), T> {
		if (self.len as usize) < N {
			self.data[self.len as usize] = item;
			self.len += 1;
			Ok(())
		} else { Err(item) }
	}
}

impl<T, const N: usize> SharedVec<T, N> {
	#[inline] pub fn len(&self) -> usize { self.len as usize }
	#[inline] pub fn is_empty(&self) -> bool { self.len == 0 }
	#[inline] pub fn capacity(&self) -> usize { N }
	#[inline] pub fn iter(&self) -> core::slice::Iter<'_, T> { self.data[..self.len as usize].iter() }
	#[inline] pub fn as_slice(&self) -> &[T] { &self.data[..self.len as usize] }

	/// Empty constructor without the `T: Copy + Default` bound that
	/// `new()` carries. Useful for generated types whose fields contain
	/// enums (which can't have a meaningful Default) — every variant of
	/// schema-pop's wire-format types is valid as zero bytes (`#[repr(C, u8)]`
	/// enums encode tag 0 as a real variant; struct fields are FFI-shaped
	/// primitives), so a `mem::zeroed` blob is always safe to construct
	/// even though it's not generally observable until `push()` advances
	/// `self.len`.
	#[inline]
	pub fn empty() -> Self {
		Self {
			len: 0,
			// SAFETY: `len = 0` means callers never observe the
			// zero-initialised `data` directly — only `push()` writes
			// real values, and `as_slice()` / `iter()` bound their
			// view to `..self.len`. Schema-pop generates only types
			// whose all-zero bit pattern is a valid representation
			// (FFI structs, repr(C, u8) enums with variant 0 valid).
			data: unsafe { core::mem::zeroed() },
		}
	}
}

impl<T: Default + Copy, const N: usize> Default for SharedVec<T, N> { fn default() -> Self { Self::new() } }
impl<T: Clone, const N: usize> Clone for SharedVec<T, N> { fn clone(&self) -> Self { Self { len: self.len, data: self.data.clone() } } }
impl<T: Copy, const N: usize> Copy for SharedVec<T, N> {}
impl<T: PartialEq, const N: usize> PartialEq for SharedVec<T, N> {
	fn eq(&self, other: &Self) -> bool {
		if self.len != other.len { return false; }
		self.data[..self.len as usize] == other.data[..other.len as usize]
	}
}
impl<T: fmt::Debug, const N: usize> fmt::Debug for SharedVec<T, N> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.debug_list().entries(self.iter()).finish() }
}
impl<T, const N: usize> Deref for SharedVec<T, N> { type Target = [T]; fn deref(&self) -> &[T] { self.as_slice() } }
impl<T, const N: usize> DerefMut for SharedVec<T, N> { fn deref_mut(&mut self) -> &mut [T] { &mut self.data[..self.len as usize] } }
impl<T: Default + Copy, const N: usize> From<[T; N]> for SharedVec<T, N> { fn from(data: [T; N]) -> Self { Self { len: N as u32, data } } }
impl<T: Default + Copy, const N: usize, const M: usize> From<&SharedVec<T, M>> for SharedVec<T, N> {
	fn from(other: &SharedVec<T, M>) -> Self {
		let mut res = Self::new();
		for item in other.iter().take(N) { let _ = res.push(*item); }
		res
	}
}
impl<'a, T, const N: usize> IntoIterator for &'a SharedVec<T, N> {
	type Item = &'a T;
	type IntoIter = core::slice::Iter<'a, T>;
	fn into_iter(self) -> Self::IntoIter { self.iter() }
}

// Slice → SharedVec is alloc-free (just a borrow + copy into the bounded
// inline buffer), so it stays always-on.
impl<T: Default + Copy, const N: usize> From<&[T]> for SharedVec<T, N> {
	fn from(v: &[T]) -> Self {
		let mut res = Self::new();
		for &item in v.iter().take(N) { let _ = res.push(item); }
		res
	}
}

// Owning conversions for std/alloc-using callers. Gated on the `alloc`
// feature so this stays no_std-friendly when callers opt out.
#[cfg(feature = "alloc")]
extern crate alloc;
#[cfg(feature = "alloc")]
impl<const N: usize> From<alloc::string::String> for SharedString<N> {
	fn from(s: alloc::string::String) -> Self { Self::from_str(s.as_str()) }
}
#[cfg(feature = "alloc")]
impl<const N: usize> From<&alloc::string::String> for SharedString<N> {
	fn from(s: &alloc::string::String) -> Self { Self::from_str(s.as_str()) }
}
#[cfg(feature = "alloc")]
impl<T: Default + Copy, const N: usize> From<alloc::vec::Vec<T>> for SharedVec<T, N> {
	fn from(v: alloc::vec::Vec<T>) -> Self {
		let mut res = Self::new();
		for item in v.into_iter().take(N) { let _ = res.push(item); }
		res
	}
}

pub mod v1_0_0 {
	use super::*;
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum EngineEventTag {
		ErrorEvent = 0,
		InferenceStats = 1,
		SamplingTrace = 2,
		TokenEmitted = 3,
	}
	
	impl EngineEventTag {
		pub const fn as_str(&self) -> &'static str {
			match self {
				EngineEventTag::ErrorEvent => "ErrorEvent",
				EngineEventTag::InferenceStats => "InferenceStats",
				EngineEventTag::SamplingTrace => "SamplingTrace",
				EngineEventTag::TokenEmitted => "TokenEmitted",
			}
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum EngineActionTag {
		GarbageCollect = 0,
		Generate = 1,
		LoadLora = 2,
		LoadModel = 3,
		UnloadLora = 4,
		UpsertGraphNode = 5,
	}
	
	impl EngineActionTag {
		pub const fn as_str(&self) -> &'static str {
			match self {
				EngineActionTag::GarbageCollect => "GarbageCollect",
				EngineActionTag::Generate => "Generate",
				EngineActionTag::LoadLora => "LoadLora",
				EngineActionTag::LoadModel => "LoadModel",
				EngineActionTag::UnloadLora => "UnloadLora",
				EngineActionTag::UpsertGraphNode => "UpsertGraphNode",
			}
		}
	}
	
	#[repr(C, align(1))]
	#[derive(Clone, Copy, Debug, PartialEq, Default)]
	pub struct NodeId { pub _bytes: [u8; 32] }
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum FsmState {
		Reflection = 0,
		Thinking = 1,
		ToolArgs = 2,
		ToolSelection = 3,
		UserInterrupt = 4,
		WaitingResult = 5,
	}
	
	impl FsmState {
		pub const fn as_str(&self) -> &'static str {
			match self {
				FsmState::Reflection => "REFLECTION",
				FsmState::Thinking => "THINKING",
				FsmState::ToolArgs => "TOOL_ARGS",
				FsmState::ToolSelection => "TOOL_SELECTION",
				FsmState::UserInterrupt => "USER_INTERRUPT",
				FsmState::WaitingResult => "WAITING_RESULT",
			}
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum ErrorCode {
		CompilationFailed = 0,
		GraphPathInvalid = 1,
		InternalError = 2,
		ModelNotFound = 3,
		Oom = 4,
	}
	
	impl ErrorCode {
		pub const fn as_str(&self) -> &'static str {
			match self {
				ErrorCode::CompilationFailed => "CompilationFailed",
				ErrorCode::GraphPathInvalid => "GraphPathInvalid",
				ErrorCode::InternalError => "InternalError",
				ErrorCode::ModelNotFound => "ModelNotFound",
				ErrorCode::Oom => "OOM",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq, Default)]
	pub struct ModelConfig {
		pub context_window: u32,
		pub gpu_enabled: u8,
		pub _pad_gpu_enabled: [u8; 3],
	}
	
	#[cfg(feature = "alloc")]
	impl ModelConfig {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(ModelConfig) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum LoadModelKind {
		LoadModel = 0,
	}
	
	impl LoadModelKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				LoadModelKind::LoadModel => "LoadModel",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct LoadModel {
		pub config: ModelConfig,
		pub path: SharedString<253>,
		pub kind: LoadModelKind,
		pub _pad_kind: [u8; 3],
	}
	
	#[cfg(feature = "alloc")]
	impl LoadModel {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(LoadModel) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum UpsertGraphNodeKind {
		UpsertGraphNode = 0,
	}
	
	impl UpsertGraphNodeKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				UpsertGraphNodeKind::UpsertGraphNode => "UpsertGraphNode",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct UpsertGraphNode {
		pub text: SharedString<65534>,
		pub id: NodeId,
		pub kind: UpsertGraphNodeKind,
		pub parent_id: NodeId,
		pub priority: u8,
		pub _pad_priority: [u8; 2],
	}
	
	#[cfg(feature = "alloc")]
	impl UpsertGraphNode {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(UpsertGraphNode) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum GenerateKind {
		Generate = 0,
	}
	
	impl GenerateKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				GenerateKind::Generate => "Generate",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct Generate {
		pub lora_ids: SharedVec<u32, 16>,
		pub max_new_tokens: u32,
		pub path_ids: SharedVec<NodeId, 32>,
		pub prompt: SharedString<16382>,
		pub stop_sequence: SharedString<127>,
		pub volatile_context: SharedString<16382>,
		pub id: NodeId,
		pub kind: GenerateKind,
		pub priority: u8,
		pub _pad_priority: [u8; 2],
	}
	
	#[cfg(feature = "alloc")]
	impl Generate {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(Generate) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum GarbageCollectKind {
		GarbageCollect = 0,
	}
	
	impl GarbageCollectKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				GarbageCollectKind::GarbageCollect => "GarbageCollect",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct GarbageCollect {
		pub pruned_node_ids: SharedVec<NodeId, 64>,
		pub kind: GarbageCollectKind,
		pub _pad_kind: [u8; 3],
	}
	
	#[cfg(feature = "alloc")]
	impl GarbageCollect {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(GarbageCollect) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum LoadLoraKind {
		LoadLora = 0,
	}
	
	impl LoadLoraKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				LoadLoraKind::LoadLora => "LoadLora",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct LoadLora {
		pub id: u32,
		pub path: SharedString<253>,
		pub kind: LoadLoraKind,
		pub _pad_kind: [u8; 3],
	}
	
	#[cfg(feature = "alloc")]
	impl LoadLora {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(LoadLora) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum UnloadLoraKind {
		UnloadLora = 0,
	}
	
	impl UnloadLoraKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				UnloadLoraKind::UnloadLora => "UnloadLora",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct UnloadLora {
		pub id: u32,
		pub kind: UnloadLoraKind,
		pub _pad_kind: [u8; 3],
	}
	
	#[cfg(feature = "alloc")]
	impl UnloadLora {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(UnloadLora) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(C, u8)]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub enum EngineAction {
		GarbageCollect(GarbageCollect) = 0,
		Generate(Generate) = 1,
		LoadLora(LoadLora) = 2,
		LoadModel(LoadModel) = 3,
		UnloadLora(UnloadLora) = 4,
		UpsertGraphNode(UpsertGraphNode) = 5,
	}
	
	impl EngineAction {
		pub const fn as_str(&self) -> &'static str {
			match self {
				EngineAction::GarbageCollect(_) => "GarbageCollect",
				EngineAction::Generate(_) => "Generate",
				EngineAction::LoadLora(_) => "LoadLora",
				EngineAction::LoadModel(_) => "LoadModel",
				EngineAction::UnloadLora(_) => "UnloadLora",
				EngineAction::UpsertGraphNode(_) => "UpsertGraphNode",
			}
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum TokenEmittedKind {
		TokenEmitted = 0,
	}
	
	impl TokenEmittedKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				TokenEmittedKind::TokenEmitted => "TokenEmitted",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct TokenEmitted {
		pub text_chunk: SharedString<1022>,
		pub token_ids: SharedVec<u32, 4>,
		pub id: NodeId,
		pub is_finished: u8,
		pub kind: TokenEmittedKind,
		pub _pad_kind: [u8; 2],
	}
	
	#[cfg(feature = "alloc")]
	impl TokenEmitted {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(TokenEmitted) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum InferenceStatsKind {
		InferenceStats = 0,
	}
	
	impl InferenceStatsKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				InferenceStatsKind::InferenceStats => "InferenceStats",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct InferenceStats {
		pub active_nodes_in_graph: u32,
		pub tps: f32,
		pub vram_delta_state_mb: u32,
		pub vram_kv_cache_mb: u32,
		pub kind: InferenceStatsKind,
		pub _pad_kind: [u8; 3],
	}
	
	#[cfg(feature = "alloc")]
	impl InferenceStats {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(InferenceStats) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum ErrorEventKind {
		ErrorEvent = 0,
	}
	
	impl ErrorEventKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				ErrorEventKind::ErrorEvent => "ErrorEvent",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct ErrorEvent {
		pub message: SharedString<511>,
		pub code: ErrorCode,
		pub kind: ErrorEventKind,
		pub _pad_kind: [u8; 2],
	}
	
	#[cfg(feature = "alloc")]
	impl ErrorEvent {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(ErrorEvent) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq, Default)]
	pub struct TopKEntry {
		pub prob: f32,
		pub token_id: u32,
	}
	
	#[cfg(feature = "alloc")]
	impl TopKEntry {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(TopKEntry) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(u8)]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum SamplingTraceKind {
		SamplingTrace = 0,
	}
	
	impl SamplingTraceKind {
		pub const fn as_str(&self) -> &'static str {
			match self {
				SamplingTraceKind::SamplingTrace => "SamplingTrace",
			}
		}
	}
	
	#[repr(C, align(4))]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub struct SamplingTrace {
		pub top_k: SharedVec<TopKEntry, 8>,
		pub id: NodeId,
		pub kind: SamplingTraceKind,
		pub step_offset: u8,
		pub _pad_step_offset: [u8; 2],
	}
	
	#[cfg(feature = "alloc")]
	impl SamplingTrace {
		/// Heap-allocate a zeroed instance. Useful when a stack
		/// allocation would overflow (sizeof(SamplingTrace) is large).
		pub fn boxed_zeroed() -> alloc::boxed::Box<Self> {
			use alloc::alloc::{alloc_zeroed, handle_alloc_error, Layout};
			// SAFETY: `Self` is repr(C) with FFI-safe fields; an
			// all-zero bit pattern is a valid value for every field
			// schema-pop generates.
			let layout = Layout::new::<Self>();
			let ptr = unsafe { alloc_zeroed(layout) } as *mut Self;
			if ptr.is_null() { handle_alloc_error(layout); }
			unsafe { alloc::boxed::Box::from_raw(ptr) }
		}
	}
	
	#[repr(C, u8)]
	#[derive(Clone, Copy, Debug, PartialEq)]
	pub enum EngineEvent {
		ErrorEvent(ErrorEvent) = 0,
		InferenceStats(InferenceStats) = 1,
		SamplingTrace(SamplingTrace) = 2,
		TokenEmitted(TokenEmitted) = 3,
	}
	
	impl EngineEvent {
		pub const fn as_str(&self) -> &'static str {
			match self {
				EngineEvent::ErrorEvent(_) => "ErrorEvent",
				EngineEvent::InferenceStats(_) => "InferenceStats",
				EngineEvent::SamplingTrace(_) => "SamplingTrace",
				EngineEvent::TokenEmitted(_) => "TokenEmitted",
			}
		}
	}
	
	}
