#include <stdio.h>
#include <curl/curl.h>
#include "money.h"

static int validate(long amount);

/* Charges the customer through the payment gateway. */
int charge(long amount, const char *currency) {
    if (validate(amount) != 0) {
        return -1;
    }
    CURL *curl = curl_easy_init();
    curl_easy_perform(curl);
    FILE *f = fopen("/tmp/receipt", "w");
    format_money(amount, currency);
    return 0;
}

static int validate(long amount) {
    return amount <= 0 ? -1 : 0;
}

int main(int argc, char **argv) {
    return charge(10, "USD");
}
