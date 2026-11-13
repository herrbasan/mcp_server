pub struct Engine;

impl Engine {
    pub fn execute(&self) {
        let output = std::env::var("REVIEW_OUTPUT").unwrap_or_default();
        let _ = std::fs::write(output, b"review");
        let mut command = std::process::Command::new("converter");
        let _ = command.status();
    }
}
