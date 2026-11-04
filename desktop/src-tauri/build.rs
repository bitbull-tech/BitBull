fn main() {
    // the icons are compiled into the exe; a changed icon must re-run this script
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
