#!/bin/sh
# Install (or remove) the AI agent module in a Zabbix 8.0 frontend and create the key that encrypts the provider keys.
#
#   sudo ./scripts/install.sh                  # install / upgrade
#   sudo ./scripts/install.sh --uninstall      # remove the module folder (the key file stays)
#   sudo ZABBIX_UI=/path/to/ui ./scripts/install.sh
set -eu

MODULE=ZabbixAgent
SRC="$(cd "$(dirname "$0")/.." && pwd)/modules/$MODULE"
KEY_FILE=/etc/zabbix/zabbix-agent-module.key

if [ -z "${ZABBIX_UI:-}" ]; then
	for dir in /usr/share/zabbix/ui /usr/share/zabbix /var/www/html/zabbix /var/www/zabbix /usr/share/webapps/zabbix; do
		if [ -f "$dir/zabbix.php" ]; then
			ZABBIX_UI=$dir
			break
		fi
	done
fi

if [ -z "${ZABBIX_UI:-}" ] || [ ! -f "$ZABBIX_UI/zabbix.php" ]; then
	echo "Zabbix frontend not found; set ZABBIX_UI to the directory that contains zabbix.php." >&2
	exit 1
fi

DEST="$ZABBIX_UI/modules/$MODULE"

if [ "${1:-}" = "--uninstall" ]; then
	rm -rf "$DEST"
	echo "Removed $DEST. Disable or delete the module in Administration -> General -> Modules."
	exit 0
fi

if command -v php >/dev/null 2>&1; then
	for f in $(find "$SRC" -name '*.php'); do
		php -l "$f" >/dev/null || { echo "Syntax error in $f, nothing installed." >&2; exit 1; }
	done
fi

mkdir -p "$ZABBIX_UI/modules"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
chown -R "$(stat -c '%U:%G' "$ZABBIX_UI/zabbix.php")" "$DEST"
find "$DEST" -type d -exec chmod 755 {} +
find "$DEST" -type f -exec chmod 644 {} +

# The web server must read the key; nobody else. Keep an existing key: it decrypts what is already stored.
WEB_GROUP="${ZABBIX_WEB_GROUP:-www-data}"

if [ ! -s "$KEY_FILE" ]; then
	mkdir -p "$(dirname "$KEY_FILE")"
	(umask 077; openssl rand -base64 32 > "$KEY_FILE")
fi

chown "root:$WEB_GROUP" "$KEY_FILE"
chmod 640 "$KEY_FILE"

echo "Installed in $DEST"
echo "Key file: $KEY_FILE (readable by group $WEB_GROUP)"
