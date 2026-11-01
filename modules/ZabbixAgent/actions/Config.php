<?php declare(strict_types = 0);

namespace Modules\ZabbixAgent\Actions;

use CController,
	CControllerResponseData,
	CWebUser;

use Modules\ZabbixAgent\Includes\Settings;

/**
 * Configuration of the floating chat, which every page of Zabbix asks for when it loads.
 */
class Config extends CController {

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
		$this->setResponse((new CControllerResponseData(['main_block' => json_encode([
			'config' => Settings::clientConfig($this->getUserType() == USER_TYPE_SUPER_ADMIN)
		])]))->disableView());
	}
}
