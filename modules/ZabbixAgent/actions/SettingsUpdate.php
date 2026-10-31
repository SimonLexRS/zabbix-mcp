<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData;

use Modules\ZabbixAgent\Includes\{
	I18n,
	Settings
};

use Throwable;

/**
 * Saves the settings. Empty keys keep the current ones; the response never includes a key.
 */
class SettingsUpdate extends CController {

	protected function checkInput(): bool {
		return $this->validateInput(['payload' => 'required|string']);
	}

	protected function checkPermissions(): bool {
		return $this->getUserType() == USER_TYPE_SUPER_ADMIN;
	}

	protected function doAction(): void {
		try {
			$input = json_decode($this->getInput('payload'), true);

			if (!is_array($input)) {
				throw new \InvalidArgumentException(I18n::t('Invalid request.'));
			}

			$settings = Settings::merge(Settings::get(), $input);

			$output = Settings::save($settings)
				? ['settings' => Settings::forBrowser($settings)]
				: ['error' => I18n::t('Cannot save the settings.')];
		}
		catch (Throwable $exception) {
			$output = ['error' => $exception->getMessage()];
		}

		$this->setResponse((new CControllerResponseData(['main_block' => json_encode($output)]))->disableView());
	}
}
