// End-to-end tests run against the compiled program in LiteSVM. They load
// target/deploy/fundraiser.so, so run `anchor build` first:
//
//   anchor build && cargo test -p fundraiser

mod campaign;
mod claim;
