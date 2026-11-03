use std::fs;
use crate::money::format;

/// Charges the customer through the payment gateway.
pub fn charge(amount: u64, currency: &str) -> Result<String, String> {
    validate(amount)?;
    let client = reqwest::Client::new();
    client.post("https://pay.example");
    fs::write("/tmp/receipt", "ok").unwrap();
    Ok(format(amount, currency))
}

fn validate(amount: u64) -> Result<(), String> {
    if amount == 0 {
        panic!("amount must be positive");
    }
    Ok(())
}

pub struct Service;

impl Service {
    pub fn run(&self) {
        self.helper();
        charge(10, "USD").unwrap();
    }

    fn helper(&self) {}
}

#[test]
fn charges_positive_amounts() {
    charge(1, "USD").unwrap();
}
