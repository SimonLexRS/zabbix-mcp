<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Includes;

use API,
	APP;

/**
 * Configuration of the module, stored in its "config" field in Zabbix. Keys are encrypted and never leave the server.
 */
class Settings {

	public const MODULE_ID = 'zabbixagent';
	public const DEFAULTS = [
		'mcp_url' => 'http://127.0.0.1:8443/mcp',
		'max_steps' => 25,
		'context_tokens' => 100000,
		'instructions' => '',
		'default_provider' => '',
		'providers' => []
	];

	public static function get(): array {
		$module = APP::ModuleManager()->getModule(self::MODULE_ID);
		$config = $module !== null ? $module->getConfig() : [];

		return $config + self::DEFAULTS;
	}

	/**
	 * The settings without any key, safe for the browser.
	 */
	public static function forBrowser(array $settings): array {
		$settings['providers'] = array_map(static function (array $provider): array {
			$provider['has_key'] = ($provider['key'] ?? '') !== '';
			unset($provider['key']);

			return $provider;
		}, $settings['providers']);

		return $settings;
	}

	public static function provider(array $settings, string $id): ?array {
		foreach ($settings['providers'] as $provider) {
			if ($provider['id'] === $id) {
				return $provider;
			}
		}

		return null;
	}

	/**
	 * Build the stored form of what the settings page sent. An empty key keeps the current one.
	 */
	public static function merge(array $current, array $input): array {
		$providers = [];

		foreach ($input['providers'] ?? [] as $provider) {
			$id = preg_replace('/[^a-z0-9-]/', '', strtolower((string) ($provider['id'] ?? '')));
			$type = $provider['type'] ?? '';
			$base_url = rtrim(trim((string) ($provider['base_url'] ?? '')), '/');
			$model = trim((string) ($provider['model'] ?? ''));

			if ($id === '' || !in_array($type, Llm::TYPES, true) || $model === ''
					|| !preg_match('#^https?://#i', $base_url)) {
				throw new \InvalidArgumentException(I18n::t('Each provider needs a type, an http(s) URL and a model.'));
			}

			$key = (string) ($provider['key'] ?? '');
			$existing = self::provider($current, $id);

			$providers[] = [
				'id' => $id,
				'name' => trim((string) ($provider['name'] ?? '')) ?: $id,
				'type' => $type,
				'base_url' => $base_url,
				'model' => $model,
				'max_tokens' => max(256, (int) ($provider['max_tokens'] ?? 4096)),
				'key' => $key !== '' ? Crypto::encrypt($key) : ($existing['key'] ?? '')
			];
		}

		$ids = array_column($providers, 'id');
		$default = (string) ($input['default_provider'] ?? '');

		return [
			'mcp_url' => trim((string) ($input['mcp_url'] ?? self::DEFAULTS['mcp_url'])),
			'max_steps' => min(100, max(1, (int) ($input['max_steps'] ?? self::DEFAULTS['max_steps']))),
			'context_tokens' => max(4000, (int) ($input['context_tokens'] ?? self::DEFAULTS['context_tokens'])),
			'instructions' => (string) ($input['instructions'] ?? ''),
			'default_provider' => in_array($default, $ids, true) ? $default : ($ids[0] ?? ''),
			'providers' => $providers
		];
	}

	public static function save(array $settings): bool {
		$modules = API::Module()->get([
			'output' => ['moduleid'],
			'filter' => ['id' => self::MODULE_ID]
		]);

		if (!$modules) {
			return false;
		}

		return (bool) API::Module()->update([[
			'moduleid' => $modules[0]['moduleid'],
			'config' => $settings
		]]);
	}
}
