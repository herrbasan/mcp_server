mod engine;

use crate::engine::Engine;

pub fn run() {
    let engine = Engine;
    engine.execute();
}
