//! Core library for ETS2 Livery Studio.
//!
//! * [`cityhash`] – CityHash64 v1.0 as used by SCS HashFS archives
//! * [`hashfs`]   – HashFS v1/v2, zip and folder archives plus a layered virtual file system
//! * [`sii`]      – tolerant text SII parser
//! * [`game`]     – game installation detection and vehicle indexing
//! * [`model`]    – PMD/PMG model + .mat parsing
//! * [`texture`]  – DDS and TOBJ writers
//! * [`export`]   – paint job mod builder

pub mod cityhash;
pub mod error;
pub mod export;
pub mod game;
pub mod hashfs;
pub mod model;
pub mod sii;
pub mod texture;

pub use error::{Error, Result};
