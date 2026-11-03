#include <string>
#include <stdexcept>
#include "money.h"

namespace billing {

// Charges the customer through the payment gateway.
std::string charge(long amount, const std::string& currency) {
    validate(amount);
    return money::format(amount, currency);
}

void validate(long amount) {
    if (amount <= 0) throw std::invalid_argument("amount must be positive");
}

class Service {
public:
    void run() {
        this->helper();
        charge(10, "USD");
    }

private:
    void helper() {}
};

void Service::reset() {
    helper();
}

}  // namespace billing
