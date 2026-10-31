<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Includes;

use CWebUser;

/**
 * Translations of the module: texts in English, looked up in lang/<language>.php by the language of the user.
 */
class I18n {

	private static ?string $lang = null;
	private static array $catalogs = [];

	public static function t(string $text): string {
		return self::catalog()[$text] ?? $text;
	}

	public static function catalog(): array {
		$lang = self::$lang ?? (class_exists(CWebUser::class, false) ? substr((string) CWebUser::getLang(), 0, 2) : 'en');

		if (!array_key_exists($lang, self::$catalogs)) {
			$file = __DIR__.'/../lang/'.basename($lang).'.php';
			self::$catalogs[$lang] = is_file($file) ? require $file : [];
		}

		return self::$catalogs[$lang];
	}

	public static function setLanguage(?string $lang): void {
		self::$lang = $lang;
	}
}
