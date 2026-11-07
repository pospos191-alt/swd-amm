#!/bin/sh
# Builds dist/woocommerce-swd-pay.zip for "Plugins → Add New → Upload Plugin" (tests and docs for developers left out).
set -eu
cd "$(dirname "$0")/.."
for f in $(find . -name '*.php' -not -path './dist/*'); do php -l "$f" >/dev/null; done
php tests/run.php
php tests/gateway-smoke.php >/dev/null
rm -rf dist && mkdir -p dist/woocommerce-swd-pay
cp -r woocommerce-swd-pay.php uninstall.php readme.txt includes assets dist/woocommerce-swd-pay/
(cd dist && zip -q -r -X woocommerce-swd-pay.zip woocommerce-swd-pay && rm -rf woocommerce-swd-pay)
echo "wrote dist/woocommerce-swd-pay.zip"
