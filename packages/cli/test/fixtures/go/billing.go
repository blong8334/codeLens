package billing

import (
	"errors"
	"net/http"

	"github.com/acme/shop/money"
)

// Charge charges the customer through the payment gateway.
func Charge(amount int, currency string) (string, error) {
	if err := validate(amount); err != nil {
		return "", err
	}
	http.Post("https://pay.example", "application/json", nil)
	return money.Format(amount, currency), nil
}

func validate(amount int) error {
	if amount <= 0 {
		panic(errors.New("amount must be positive"))
	}
	return nil
}

type Service struct{}

func (s *Service) Run() {
	s.helper()
	Charge(10, "USD")
}

func (s *Service) helper() {}

func HandleCharge(w http.ResponseWriter, r *http.Request) {
	Charge(1, "USD")
}
