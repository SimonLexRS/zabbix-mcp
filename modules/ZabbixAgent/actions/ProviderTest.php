<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData;

use Modules\ZabbixAgent\Includes\{
	Crypto,
	I18n,
	Llm,
	Settings
};

use Throwable;

/**
 * Tests a provider with a minimal request, using the key typed in or the stored one.
 */
class ProviderTest extends CController {

	protected function checkInput(): bool {
		return $this->validateInput(['payload' => 'required|string']);
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function doAction(): void {
		try {
			$input = json_decode($this->getInput('payload'), true);

			if (!is_array($input) || !in_array($input['type'] ?? '', Llm::TYPES, true)
					|| !preg_match('#^https?://#i', (string) ($input['base_url'] ?? ''))) {
				throw new \InvalidArgumentException(I18n::t('Each provider needs a type, an http(s) URL and a model.'));
			}

			$stored = Settings::provider(Settings::get(), (string) ($input['id'] ?? ''));
			$key = (string) ($input['key'] ?? '');

			if ($key === '' && ($stored['key'] ?? '') !== '') {
				$key = Crypto::decrypt($stored['key']);
			}

			$model = Llm::test([
				'type' => $input['type'],
				'base_url' => rtrim($input['base_url'], '/'),
				'model' => (string) ($input['model'] ?? '')
			], $key);

			$output = ['ok' => true, 'model' => $model];
		}
		catch (Throwable $exception) {
			$output = ['error' => $exception->getMessage()];
		}

		$this->setResponse((new CControllerResponseData(['main_block' => json_encode($output)]))->disableView());
	}
}
