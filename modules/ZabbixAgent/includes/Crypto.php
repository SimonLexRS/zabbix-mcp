<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Includes;

use RuntimeException;

/**
 * Encrypts the keys of the providers. The key file lives outside the web root, so neither the database nor a backup of
 * it are enough to read them.
 */
class Crypto {

	public const KEY_FILE = '/etc/zabbix/zabbix-agent-module.key';

	private const CIPHER = 'aes-256-gcm';

	public static function encrypt(string $plain, ?string $key = null): string {
		$key = $key ?? self::key();
		$iv = random_bytes(12);
		$tag = '';
		$cipher = openssl_encrypt($plain, self::CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag);

		if ($cipher === false) {
			throw new RuntimeException('Cannot encrypt.');
		}

		return base64_encode($iv.$tag.$cipher);
	}

	public static function decrypt(string $stored, ?string $key = null): string {
		$key = $key ?? self::key();
		$raw = base64_decode($stored, true);

		if ($raw === false || strlen($raw) < 29) {
			throw new RuntimeException('Invalid stored key.');
		}

		$plain = openssl_decrypt(substr($raw, 28), self::CIPHER, $key, OPENSSL_RAW_DATA, substr($raw, 0, 12),
			substr($raw, 12, 16)
		);

		if ($plain === false) {
			throw new RuntimeException('Cannot decrypt the stored key: the key file changed.');
		}

		return $plain;
	}

	private static function key(): string {
		$content = is_readable(self::KEY_FILE) ? file_get_contents(self::KEY_FILE) : false;
		$key = $content === false ? false : base64_decode(trim($content), true);

		if ($key === false || strlen($key) !== 32) {
			throw new RuntimeException('Cannot read '.self::KEY_FILE.': run scripts/install.sh.');
		}

		return $key;
	}
}
