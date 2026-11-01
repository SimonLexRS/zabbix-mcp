<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData,
	CWebUser;

use Modules\ZabbixAgent\Includes\{
	I18n,
	Settings
};

/**
 * The chat page.
 */
class View extends CController {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function checkPermissions(): bool {
		return CWebUser::isLoggedIn() && !CWebUser::isGuest();
	}

	protected function doAction(): void {
		$this->setResponse(new CControllerResponseData([
			'title' => I18n::t('AI agent'),
			'config' => Settings::clientConfig($this->getUserType() == USER_TYPE_SUPER_ADMIN)
		]));
	}
}
