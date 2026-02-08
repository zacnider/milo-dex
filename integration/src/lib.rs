pub mod helpers;
pub mod milo_accounts;

use miden_objects::assembly::{Assembler, DefaultSourceManager, LibraryPath, Module, ModuleKind};
use std::sync::Arc;

/// Creates a library from MASM source code (similar to ZoroSwap's create_library)
pub fn create_library(
    assembler: Assembler,
    library_path: &str,
    source_code: &str,
) -> Result<miden_client::assembly::Library, Box<dyn std::error::Error>> {
    let source_manager = Arc::new(DefaultSourceManager::default());
    let module = Module::parser(ModuleKind::Library).parse_str(
        LibraryPath::new(library_path)?,
        source_code,
        &source_manager,
    )?;
    let library = assembler.assemble_library([module])?;
    Ok(library)
}
