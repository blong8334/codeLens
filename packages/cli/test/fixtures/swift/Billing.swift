import Foundation

/// Charges the customer through the payment gateway.
public func charge(amount: Int, currency: String) throws -> String {
    try validate(amount: amount)
    URLSession.shared.dataTask(with: URL(string: "https://pay.example")!)
    return format(amount: amount, currency: currency)
}

func validate(amount: Int) throws {
    if amount <= 0 {
        throw BillingError.invalidAmount
    }
}

class Service {
    func run() async {
        self.helper()
        _ = try? charge(amount: 10, currency: "USD")
    }

    private func helper() {}
}
